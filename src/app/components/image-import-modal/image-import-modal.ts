import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord, PendingImageReview, RankedImageMatch } from '../../types/coin.model';

/**
 * Image import + review screen.
 *
 * The matching service deliberately refuses to guess (see
 * image-matching.service.ts). That means this component has one job beyond
 * showing results: give the user a fast way to resolve everything the matcher
 * was not sure about.
 *
 * Three buckets are shown:
 *   1. "Ready to attach"  - the matcher was near-certain. Pre-selected; the
 *                           user can reject or reassign.
 *   2. "Needs your choice"- plausible candidates exist. The user picks one,
 *                           searches for a different coin, or skips.
 *   3. "No match found"   - nothing worth suggesting. Search or skip.
 *
 * Nothing is written to the inventory until "Attach" is pressed.
 */
@Component({
  selector: 'app-image-import-modal',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './image-import-modal.html',
  styleUrl: './image-import-modal.scss'
})
export class ImageImportModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly imageMatchingService = inject(ImageMatchingService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();

  /** One row per selected image file. */
  protected readonly imageReviews = signal<PendingImageReview[]>([]);

  /** Per-image free-text coin search ("filename" -> "search text"). */
  protected readonly coinSearches = signal<Record<string, string>>({});

  /** The actual File objects, kept so we can read their bytes on apply. */
  private pendingFiles = new Map<string, File>();

  /* ---------------------------------------------------------------------
   * Grouping for the template
   * ------------------------------------------------------------------- */

  /** Matcher was confident. Still rejectable/reassignable. */
  protected readonly autoMatches = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'auto')
  );

  /** Matcher had candidates but was not certain. */
  protected readonly reviewMatches = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'review')
  );

  /** Matcher had nothing worth suggesting. */
  protected readonly unmatchedImages = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'none')
  );

  /** Rows that still need a decision from the user. */
  protected readonly outstandingCount = computed(() =>
    this.imageReviews().filter(r => r.decision === 'review').length
  );

  /** Rows that will actually be written when "Attach" is pressed. */
  protected readonly readyToAttach = computed(() =>
    this.imageReviews().filter(
      r => (r.decision === 'auto' || r.decision === 'confirmed') && r.selectedCoinId
    )
  );

  protected readonly attachCount = computed(() => this.readyToAttach().length);

  /* ---------------------------------------------------------------------
   * File selection
   * ------------------------------------------------------------------- */

  async handleDirectorySelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    this.cleanupPendingImages();

    const fileNames = imageFiles.map(f => f.name);
    const results = this.imageMatchingService.matchImages(fileNames, this.inv.inventory());

    const rows: PendingImageReview[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const result = results[i];
      this.pendingFiles.set(file.name, file);

      let thumbnailUrl = '';
      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        thumbnailUrl = URL.createObjectURL(file);
      }

      // Only an 'auto' result arrives pre-selected. 'review' and 'none' start
      // with nothing chosen, so an unattended import can never mis-file a coin.
      const isAuto = result.status === 'auto' && !!result.matchedRecordId;

      rows.push({
        fileName: file.name,
        thumbnailUrl,
        result,
        selectedCoinId: isAuto ? result.matchedRecordId : null,
        selectionReason: result.reason,
        confidence: result.confidence,
        decision: isAuto ? 'auto' : 'review'
      });
    }

    this.imageReviews.set(rows);
    this.coinSearches.set({});
    input.value = '';
  }

  /* ---------------------------------------------------------------------
   * User decisions
   * ------------------------------------------------------------------- */

  /** Accept the matcher's pre-selected coin. */
  confirmImageMatch(fileName: string): void {
    const row = this.rowFor(fileName);
    if (!row?.selectedCoinId) return;
    this.updateRow(fileName, { decision: 'confirmed' });
  }

  /** Drop the matcher's suggestion and hand the decision back to the user. */
  rejectImageMatch(fileName: string): void {
    this.updateRow(fileName, {
      decision: 'review',
      selectedCoinId: null,
      confidence: 0,
      selectionReason: 'Suggestion rejected - choose a coin or skip this image.'
    });
  }

  /** Pick one of the ranked candidates the matcher offered. */
  chooseCandidate(fileName: string, candidate: RankedImageMatch): void {
    this.updateRow(fileName, {
      decision: 'confirmed',
      selectedCoinId: candidate.coinId,
      confidence: candidate.score,
      selectionReason: `Chosen from suggestions: ${candidate.reason}`
    });
  }

  /** Assign to any coin in the inventory (from the search box or dropdown). */
  reassignImageMatch(fileName: string, coinId: string): void {
    if (!coinId) {
      this.updateRow(fileName, { decision: 'review', selectedCoinId: null, confidence: 0 });
      return;
    }
    this.updateRow(fileName, {
      decision: 'confirmed',
      selectedCoinId: coinId,
      confidence: 1,
      selectionReason: `Manually assigned to ${this.coinNameById(coinId)}.`
    });
    this.setCoinSearch(fileName, '');
  }

  /** Leave this image alone. */
  skipImage(fileName: string): void {
    this.updateRow(fileName, {
      decision: 'skipped',
      selectedCoinId: null,
      confidence: 0,
      selectionReason: 'Skipped - this image will not be attached.'
    });
  }

  /** Undo a skip / confirmation and go back to needing a decision. */
  resetDecision(fileName: string): void {
    const row = this.rowFor(fileName);
    if (!row) return;
    const isAuto = row.result.status === 'auto' && !!row.result.matchedRecordId;
    this.updateRow(fileName, {
      decision: isAuto ? 'auto' : 'review',
      selectedCoinId: isAuto ? row.result.matchedRecordId : null,
      confidence: isAuto ? row.result.confidence : 0,
      selectionReason: row.result.reason
    });
  }

  /* ---------------------------------------------------------------------
   * Coin search (for "none of these candidates is right")
   * ------------------------------------------------------------------- */

  setCoinSearch(fileName: string, term: string): void {
    this.coinSearches.set({ ...this.coinSearches(), [fileName]: term });
  }

  coinSearchTerm(fileName: string): string {
    return this.coinSearches()[fileName] ?? '';
  }

  /** Up to 8 inventory coins whose label contains every word typed. */
  coinSearchResults(fileName: string): CoinRecord[] {
    const term = this.coinSearchTerm(fileName).trim().toLowerCase();
    if (term.length < 2) return [];
    const words = term.split(/\s+/);
    return this.inv
      .inventory()
      .filter(coin => {
        const label = this.coinNameById(coin.id).toLowerCase();
        return words.every(word => label.includes(word));
      })
      .slice(0, 8);
  }

  /* ---------------------------------------------------------------------
   * Display helpers
   * ------------------------------------------------------------------- */

  coinNameById(coinId: string | null): string {
    if (!coinId) return 'None';
    const coin = this.inv.inventory().find(c => c.id === coinId);
    if (!coin) return 'Unknown';
    return this.imageMatchingService.describeCoin(coin);
  }

  /**
   * "What we read from the filename", as chips the user can sanity-check.
   * An empty list means the filename told us nothing.
   */
  parsedChips(row: PendingImageReview): string[] {
    const parsed = row.result.parsed;
    const chips: string[] = [];
    if (parsed.year !== null) chips.push(`Year ${parsed.year}`);
    if (parsed.mintMark) chips.push(`Mint ${parsed.mintMark.toUpperCase()}`);
    if (parsed.denominationLabel) chips.push(parsed.denominationLabel);
    if (parsed.coinTypeTokens.length) chips.push(`Type: ${parsed.coinTypeTokens.join(' ')}`);
    if (parsed.grade) chips.push(`Grade ${parsed.grade.toUpperCase()}`);
    for (const cert of parsed.certNumbers) chips.push(`Cert ${cert}`);
    return chips;
  }

  /* ---------------------------------------------------------------------
   * Apply
   * ------------------------------------------------------------------- */

  async applyConfirmedMatches(): Promise<void> {
    for (const row of this.readyToAttach()) {
      const file = this.pendingFiles.get(row.fileName);
      if (!file || !row.selectedCoinId) continue;
      const dataUrl = await this.readFileAsDataUrl(file);
      const coin = this.inv.inventory().find(c => c.id === row.selectedCoinId);
      if (!coin) continue;
      this.inv.updateCoin(coin.id, { imagePaths: [...new Set([...coin.imagePaths, dataUrl])] });
    }

    this.close();
  }

  close(): void {
    this.cleanupPendingImages();
    this.closed.emit();
  }

  /* ---------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------- */

  private rowFor(fileName: string): PendingImageReview | undefined {
    return this.imageReviews().find(r => r.fileName === fileName);
  }

  private updateRow(fileName: string, updates: Partial<PendingImageReview>): void {
    this.imageReviews.set(
      this.imageReviews().map(r => (r.fileName === fileName ? { ...r, ...updates } : r))
    );
  }

  private cleanupPendingImages(): void {
    for (const row of this.imageReviews()) {
      if (row.thumbnailUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(row.thumbnailUrl);
      }
    }
    this.imageReviews.set([]);
    this.coinSearches.set({});
    this.pendingFiles.clear();
  }

  private async readFileAsDataUrl(file: File): Promise<string> {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = this.encodeBase64(new Uint8Array(buffer));
      return `data:${file.type || 'application/octet-stream'};base64,${base64}`;
    } catch { return file.name; }
  }

  private encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
}
