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
