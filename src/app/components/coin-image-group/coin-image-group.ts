import { Component, computed, input, output } from '@angular/core';
import {
  BatchImageRow,
  CoinImageGroup,
  PhotoSide,
  SelectionBulkAction
} from '../../types/coin.model';
import { sideLabel } from '../../services/image-import/photo-variant';

/**
 * One coin in the batch image import review: the coin and the photos proposed
 * for it, grouped Obverse / Reverse / Label / Other with per-coin bulk buttons.
 * Collapsed by default, because thumbnails load full-size files from the share;
 * the parent creates object URLs only for expanded groups.
 */
@Component({
  selector: 'app-coin-image-group',
  imports: [],
  templateUrl: './coin-image-group.html',
  styleUrl: './coin-image-group.scss'
})
export class CoinImageGroupRow {
  /** The coin and its proposed photos. */
  readonly group = input.required<CoinImageGroup>();

  /** True when the thumbnails should be rendered. */
  readonly expanded = input(false);

  /** Object URLs by filename. Owned by the parent so it can revoke them on close. */
  readonly thumbnailUrls = input<Record<string, string>>({});

  /** The user clicked the header; the parent should create thumbnails. */
  readonly expandToggled = output<string>();

  /** A single tick-box changed. Emits the filename. */
  readonly rowToggled = output<string>();

  /**
   * "Skip this coin": marks every photo skipped and removes the group from the
   * list. Emits the coin id. Unlike "None", which only unticks.
   */
  readonly skipped = output<string>();

  /** A per-coin bulk button was pressed. */
  readonly bulkAction = output<SelectionBulkAction>();

  /** The photo sections, in reading order, skipping any that are empty. */
  protected readonly sections = computed(() => {
    const rows = this.group().rows;
    const order: PhotoSide[] = ['obverse', 'reverse', 'label', 'unknown'];
    return order
      .map(side => ({
        side,
        label: sideLabel(side),
        rows: rows.filter(r => r.photo.side === side)
      }))
      .filter(section => section.rows.length > 0);
  });

  /** True when at least one photo in this coin's group is a retake. */
  protected readonly hasRetakes = computed(() => this.group().rows.some(r => r.photo.isRetake));

  /** True when at least one photo is a slab label shot. */
  protected readonly hasLabels = computed(() =>
    this.group().rows.some(r => r.photo.side === 'label')
  );

  /** Object URL for a row, or '' while the group is still collapsed. */
  protected thumbnailFor(row: BatchImageRow): string {
    return this.thumbnailUrls()[row.fileName] ?? '';
  }

  /** Short caption such as "Obverse · Small" or "Reverse · take 2". */
  protected caption(row: BatchImageRow): string {
    const parts = [sideLabel(row.photo.side)];
    if (row.photo.variant) parts.push(row.photo.variant);
    if (row.photo.takeNumber !== null && row.photo.takeNumber >= 2) {
      parts.push(`take ${row.photo.takeNumber}`);
    }
    return parts.join(' · ');
  }

  /** Original file size, e.g. "2.4 MB". */
  protected fileSize(row: BatchImageRow): string {
    if (!row.sizeBytes) return '';
    const mb = row.sizeBytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`;
  }
}
