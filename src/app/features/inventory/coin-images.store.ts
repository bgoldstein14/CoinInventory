import { signal } from '@angular/core';
import { coinImagesInMemory, coinPhotoCount } from '../../services/coin-photos';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';

/**
 * CoinImagesStore — photos for the selected coin: the gallery overlay, the
 * full-screen viewer, and adding/removing/reordering images. Shared by the
 * inventory table, detail panel, gallery, viewer and App shell.
 *
 * `GET /api/coins` doesn't include photos, so `coin.imagePaths` is absent
 * until `InventoryService.loadCoinImages()` fetches it.
 *   - Reads use `coinPhotoCount(coin)`, which falls back to the list's `imageCount`.
 *   - Writes send the complete array (`PUT /api/coins/:id` replaces all image
 *     rows), so each write first ensures the images are loaded and does
 *     nothing if they aren't — a partial array would delete photos.
 */
export class CoinImagesStore {
  /** Is the gallery overlay open? */
  readonly showImageGallery = signal(false);

  /** Is the full-screen photo viewer open? */
  readonly showPhotoViewer = signal(false);

  /** Index of the image shown in the viewer. */
  readonly photoViewerIndex = signal<number>(0);

  constructor(private readonly inv: InventoryService) {}

  private get selectedCoin(): CoinRecord | null {
    return this.inv.selectedCoin();
  }

  /** The coin's photos, loaded for modification, or null if they couldn't be loaded. */
  private async loadedImagesForWrite(coin: CoinRecord): Promise<string[] | null> {
    const inMemory = coinImagesInMemory(coin);
    if (inMemory) return inMemory;

    try {
      return await this.inv.loadCoinImages(coin.id);
    } catch {
      // Already logged by the loader. Don't write on a failed read.
      return null;
    }
  }

  // --- Gallery overlay ---

  /**
   * The gallery opens for any selected coin, even with no photos: it's where
   * the first photo gets added, so it must not be gated on existing images.
   */
  canOpenImageGallery(coin: CoinRecord | null): boolean {
    return !!coin;
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

  // --- Full-screen photo viewer ---

  openPhotoViewer(index: number): void {
    const coin = this.selectedCoin;
    // coinPhotoCount works before the photos have loaded.
    if (!coin || coinPhotoCount(coin) === 0) return;
    this.photoViewerIndex.set(index);
    this.showPhotoViewer.set(true);
  }

  closePhotoViewer(): void { this.showPhotoViewer.set(false); }

  /** Step forwards (+1) or backwards (-1) through the photos, wrapping at both ends. */
  movePhotoViewer(step: number): void {
    const coin = this.selectedCoin;
    const count = coinPhotoCount(coin);
    if (!coin || count === 0) return;
    this.photoViewerIndex.set((this.photoViewerIndex() + step + count) % count);
  }

  // --- Adding & removing photos ---

  /** Handles the "Add images" file picker inside the gallery. */
  async addCoinImages(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const coin = this.selectedCoin;
    if (!coin || files.length === 0) return;

    // Existing photos must be loaded first, or the new ones would replace them.
    const existing = await this.loadedImagesForWrite(coin);
    if (!existing) return;

    const nextPaths = [...existing];
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

  /** The browser only fires `drop` if `dragover` is cancelled. */
  handleDragOver(event: DragEvent): void { event.preventDefault(); }

  removeCoinImage(imagePath: string): void {
    const coin = this.selectedCoin;
    if (!coin) return;

    // The delete is sent as the full remaining set, so require it to be loaded.
    const existing = coinImagesInMemory(coin);
    if (!existing) return;

    this.inv.updateCoin(coin.id, { imagePaths: existing.filter(p => p !== imagePath) });
  }

  // --- Main photo (grid thumbnail) ---

  /** Is this the grid thumbnail? The grid shows `imagePaths[0]`. */
  isMainImage(imagePath: string): boolean {
    const coin = this.selectedCoin;
    const existing = coinImagesInMemory(coin);
    if (!existing || existing.length === 0) return false;
    return existing[0] === imagePath;
  }

  /**
   * Make the chosen photo the grid thumbnail by moving it to the front.
   * The server stores array index as SortOrder, so no separate "primary" flag
   * is needed.
   *
   * Goes through `inv.updateCoin` (not the API directly) so each image's
   * `sourcePath` is re-attached (see services/image-source-paths.ts);
   * otherwise the PUT would clear them.
   */
  setMainImage(imagePath: string): void {
    const coin = this.selectedCoin;
    if (!coin) return;

    // The reorder sends the whole array, so require it to be loaded.
    const existing = coinImagesInMemory(coin);
    if (!existing) return;

    const index = existing.indexOf(imagePath);

    // Unknown or already first: skip, since a PUT would rewrite every image row.
    if (index <= 0) return;

    // Move to front, keeping the others' relative order; don't mutate the bound array.
    const reordered = [imagePath, ...existing.filter(p => p !== imagePath)];

    this.inv.updateCoin(coin.id, { imagePaths: reordered });
  }

  // --- Private helpers ---

  private async addDroppedFiles(files: File[]): Promise<void> {
    const coin = this.selectedCoin;
    if (!coin) return;

    // Same as addCoinImages: existing photos must be loaded first.
    const existing = await this.loadedImagesForWrite(coin);
    if (!existing) return;

    const nextPaths = [...existing];
    for (const file of files) nextPaths.push(await this.readFileAsDataUrl(file));
    this.inv.updateCoin(coin.id, { imagePaths: [...new Set(nextPaths)] });
    this.showImageGallery.set(true);
  }

  /** Reads a file into a `data:` URL; falls back to the file name on error. */
  private async readFileAsDataUrl(file: File): Promise<string> {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = this.encodeBase64(new Uint8Array(buffer));
      return `data:${file.type || 'application/octet-stream'};base64,${base64}`;
    } catch { return file.name; }
  }

  /** Base64 in 32KB chunks; spreading a whole large photo exceeds the JS argument limit. */
  private encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
}
