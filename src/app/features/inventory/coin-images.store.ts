import { signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';

/**
 * CoinImagesStore — the photos attached to the currently selected coin: the
 * gallery overlay, the full-screen viewer, and adding/removing images.
 *
 * WHY THIS FILE EXISTS
 * Four separate pieces of UI touch this state:
 *  - the inventory table ("Images" button on a row),
 *  - the detail panel ("Show images" / "Hide images"),
 *  - the gallery overlay itself (add, delete, click-to-enlarge),
 *  - the full-screen photo viewer (next/previous/close).
 * Plus the App shell, which closes the gallery whenever the selected coin
 * changes. Threading that through inputs and outputs would be a nightmare, so
 * it lives here instead.
 *
 * Images are stored inline on the coin record as `data:` URLs, which is why
 * this file also owns the file -> base64 conversion.
 */
export class CoinImagesStore {
  /** Is the gallery overlay (the list of thumbnails) open? */
  readonly showImageGallery = signal(false);

  /** Is the full-screen single-photo viewer open? */
  readonly showPhotoViewer = signal(false);

  /** Which image the full-screen viewer is currently showing. */
  readonly photoViewerIndex = signal<number>(0);

  constructor(private readonly inv: InventoryService) {}

  private get selectedCoin(): CoinRecord | null {
    return this.inv.selectedCoin();
  }

  // ===================== Gallery overlay =====================

  /** There is nothing to show for a coin with no photos, so the button is disabled. */
  canOpenImageGallery(coin: CoinRecord | null): boolean {
    return !!coin && coin.imagePaths.length > 0;
  }

  openImageGallery(): void {
    if (!this.canOpenImageGallery(this.selectedCoin)) return;
    this.showImageGallery.set(true);
  }

  closeImageGallery(): void {
    this.showImageGallery.set(false);
  }

  toggleImageGallery(): void {
    if (!this.canOpenImageGallery(this.selectedCoin)) return;
    this.showImageGallery.set(!this.showImageGallery());
  }

  // ===================== Full-screen photo viewer =====================

  openPhotoViewer(index: number): void {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) return;
    this.photoViewerIndex.set(index);
    this.showPhotoViewer.set(true);
  }

  closePhotoViewer(): void { this.showPhotoViewer.set(false); }

  /**
   * Step forwards (+1) or backwards (-1) through the photos, wrapping around at
   * both ends. The `+ length` before the modulo keeps the result positive when
   * stepping backwards from the first image.
   */
  movePhotoViewer(step: number): void {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) return;
    this.photoViewerIndex.set(
      (this.photoViewerIndex() + step + coin.imagePaths.length) % coin.imagePaths.length
    );
  }

  // ===================== Adding & removing photos =====================

  /** Handles the "Add images" file picker inside the gallery. */
  async addCoinImages(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const coin = this.selectedCoin;
    if (!coin || files.length === 0) return;

    const nextPaths = [...coin.imagePaths];
    for (const file of files) nextPaths.push(await this.readFileAsDataUrl(file));
    this.inv.updateCoin(coin.id, { imagePaths: [...new Set(nextPaths)] });
    input.value = '';
    this.showImageGallery.set(true);
  }

  /** Handles photos dragged from the desktop onto the gallery. */
  handleImageDrop(event: DragEvent): void {
    event.preventDefault();
    const coin = this.selectedCoin;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!coin || files.length === 0) return;
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    void this.addDroppedFiles(imageFiles);
  }

  /** The browser only fires `drop` if `dragover` is cancelled, hence this. */
  handleDragOver(event: DragEvent): void { event.preventDefault(); }

  removeCoinImage(imagePath: string): void {
    const coin = this.selectedCoin;
    if (!coin) return;
    this.inv.updateCoin(coin.id, { imagePaths: coin.imagePaths.filter(p => p !== imagePath) });
  }

  // ===================== Choosing the grid thumbnail ("main photo") =========

  /**
   * Is this image the one the main grid shows as the coin's thumbnail?
   *
   * The grid's Photo column renders `coin.imagePaths[0]` (see
   * InventoryTable.primaryImage), so "the main photo" is simply "position 0".
   * The gallery uses this to tick the current one and disable its button, so
   * the user can SEE which photo is the main one rather than having to guess.
   */
  isMainImage(imagePath: string): boolean {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) return false;
    return coin.imagePaths[0] === imagePath;
  }

  /**
   * Make the chosen photo the one shown in the main grid.
   *
   * ---------------------------------------------------------------------
   * WHY THIS IS A RE-ORDER AND NOT A NEW "IsPrimary" DATABASE COLUMN
   * ---------------------------------------------------------------------
   * The data model already answers this question. Every row in `CoinImages`
   * carries a `SortOrder`; `GET /api/coins/:id/images` returns them
   * `ORDER BY SortOrder`; and the grid thumbnail is the FIRST image in that
   * list. So "this photo is the main one" is already expressible as "this
   * photo is at SortOrder 0" — the information has nowhere else it could
   * live, and there is no second place for it to disagree with itself.
   *
   * Adding an `IsPrimary` flag instead would mean: a schema migration, a new
   * invariant ("exactly one row per coin has it set") that nothing enforces,
   * and a brand-new way for the gallery order and the grid thumbnail to drift
   * apart. Moving the chosen image to the front of `imagePaths` needs none of
   * that — the server rewrites SortOrder from the array index when it
   * re-inserts the rows, so array position IS SortOrder.
   *
   * A pleasant side effect: the gallery and the full-screen viewer list the
   * photos in the same order, so the main photo also becomes the first one you
   * see when you open the viewer.
   *
   * ---------------------------------------------------------------------
   * WHY WE SEND ONLY `imagePaths`, AND WHY SOURCE PATHS SURVIVE
   * ---------------------------------------------------------------------
   * `PUT /api/coins/:id` REPLACES a coin's entire image set: it deletes every
   * CoinImages row and re-inserts the array it was given. Two consequences:
   *
   *   1. The request must carry ONLY the image field. `InventoryService
   *      .updateCoin` takes a Partial<CoinRecord> and CoinEditor PUTs just the
   *      changed keys, so passing `{ imagePaths }` keeps the write atomic —
   *      no other field of the coin is touched or at risk.
   *
   *   2. Each image also has an optional `sourcePath` (where the ORIGINAL
   *      full-resolution file lives on disk). An entry sent as a bare string
   *      is re-inserted with `SourcePath NULL`, so a naive re-order would
   *      silently erase the recorded location of EVERY photo on the coin —
   *      exactly the kind of quiet data loss this project has been bitten by
   *      before. We avoid it by going through `inv.updateCoin`, because
   *      CoinEditor.withSourcePaths() re-attaches the known paths to the
   *      outgoing array (see services/image-source-paths.ts). That is why this
   *      method must NOT call the API directly: the single funnel is the
   *      protection.
   */
  setMainImage(imagePath: string): void {
    const coin = this.selectedCoin;
    if (!coin) return;

    const index = coin.imagePaths.indexOf(imagePath);

    // Unknown image, or it is already the main one. Doing nothing is important
    // rather than merely tidy: a no-op PUT would still delete and re-insert
    // every image row on the server for no reason at all.
    if (index <= 0) return;

    // Move it to the front, leaving every other photo in its existing relative
    // order. `filter` (rather than splice) keeps the original array untouched —
    // it is the one bound to the screen.
    const reordered = [imagePath, ...coin.imagePaths.filter(p => p !== imagePath)];

    this.inv.updateCoin(coin.id, { imagePaths: reordered });
  }

  // ===================== Private helpers =====================

  private async addDroppedFiles(files: File[]): Promise<void> {
    const coin = this.selectedCoin;
    if (!coin) return;
    const nextPaths = [...coin.imagePaths];
    for (const file of files) nextPaths.push(await this.readFileAsDataUrl(file));
    this.inv.updateCoin(coin.id, { imagePaths: [...new Set(nextPaths)] });
    this.showImageGallery.set(true);
  }

  /**
   * Reads a picked/dropped file into a `data:` URL so it can be stored straight
   * on the coin record. If anything goes wrong we fall back to just the file
   * name, which at least leaves a readable placeholder rather than an error.
   */
  private async readFileAsDataUrl(file: File): Promise<string> {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = this.encodeBase64(new Uint8Array(buffer));
      return `data:${file.type || 'application/octet-stream'};base64,${base64}`;
    } catch { return file.name; }
  }

  /**
   * btoa() only accepts a string, and `String.fromCharCode(...bytes)` blows the
   * JS argument limit on large photos — so convert in 32KB chunks.
   */
  private encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
}
