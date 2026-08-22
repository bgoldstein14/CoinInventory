import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { PendingImageMatch } from '../../types/coin.model';

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

  protected readonly pendingImageMatches = signal<PendingImageMatch[]>([]);
  private pendingFiles = new Map<string, File>();

  protected readonly autoMatchedImages = computed(() =>
    this.pendingImageMatches().filter(m => m.status === 'auto-matched' || m.status === 'confirmed')
  );

  protected readonly reviewImages = computed(() =>
    this.pendingImageMatches().filter(m => m.status === 'pending')
  );

  protected readonly unmatchedPendingImages = computed(() =>
    this.pendingImageMatches().filter(m => m.status === 'unmatched')
  );

  protected readonly confirmedCount = computed(() =>
    this.pendingImageMatches().filter(m => m.status === 'confirmed' || m.status === 'auto-matched').length
  );

  async handleDirectorySelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    this.cleanupPendingImages();
    const fileNames = imageFiles.map(f => f.name);
    const matches = this.imageMatchingService.matchImages(fileNames, this.inv.inventory());

    const pending: PendingImageMatch[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const match = matches[i];
      this.pendingFiles.set(file.name, file);

      let thumbnailUrl = '';
      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        thumbnailUrl = URL.createObjectURL(file);
      }

      let status: PendingImageMatch['status'];
      if (!match.matchedRecordId) status = 'unmatched';
      else if (match.confidence >= 0.6) status = 'auto-matched';
      else status = 'pending';

      pending.push({
        fileName: file.name, thumbnailUrl,
        matchedCoinId: match.matchedRecordId, confidence: match.confidence,
        reason: match.reason, status
      });
    }

    this.pendingImageMatches.set(pending);
    input.value = '';
  }

  confirmImageMatch(fileName: string): void {
    this.updatePendingMatch(fileName, { status: 'confirmed' });
  }

  rejectImageMatch(fileName: string): void {
    this.updatePendingMatch(fileName, { status: 'rejected', matchedCoinId: null });
  }

  reassignImageMatch(fileName: string, coinId: string): void {
    if (!coinId) {
      this.updatePendingMatch(fileName, { status: 'unmatched', matchedCoinId: null, confidence: 0 });
      return;
    }
    const coin = this.inv.inventory().find(c => c.id === coinId);
    this.updatePendingMatch(fileName, {
      status: 'confirmed', matchedCoinId: coinId, confidence: 1,
      reason: coin ? `Manually assigned to ${coin.name}.` : 'Manually assigned.'
    });
  }

  async applyConfirmedMatches(): Promise<void> {
    const confirmed = this.pendingImageMatches().filter(
      m => (m.status === 'confirmed' || m.status === 'auto-matched') && m.matchedCoinId
    );

    for (const match of confirmed) {
      const file = this.pendingFiles.get(match.fileName);
      if (!file || !match.matchedCoinId) continue;
      const dataUrl = await this.readFileAsDataUrl(file);
      const coin = this.inv.inventory().find(c => c.id === match.matchedCoinId);
      if (!coin) continue;
      this.inv.updateCoin(coin.id, { imagePaths: [...new Set([...coin.imagePaths, dataUrl])] });
    }

    this.close();
  }

  coinNameById(coinId: string | null): string {
    if (!coinId) return 'None';
    return this.inv.inventory().find(c => c.id === coinId)?.name ?? 'Unknown';
  }

  close(): void {
    this.cleanupPendingImages();
    this.closed.emit();
  }

  private updatePendingMatch(fileName: string, updates: Partial<PendingImageMatch>): void {
    this.pendingImageMatches.set(
      this.pendingImageMatches().map(m => m.fileName === fileName ? { ...m, ...updates } : m)
    );
  }

  private cleanupPendingImages(): void {
    for (const match of this.pendingImageMatches()) {
      if (match.thumbnailUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(match.thumbnailUrl);
      }
    }
    this.pendingImageMatches.set([]);
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
