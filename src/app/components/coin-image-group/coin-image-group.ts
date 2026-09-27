import { Component, computed, input, output } from '@angular/core';
import {
  BatchImageRow,
  CoinImageGroup,
  PhotoSide,
  SelectionBulkAction
} from '../../types/coin.model';
import { sideLabel } from '../../services/image-import/photo-variant';

/**
 * CoinImageGroup — one row of the batch-import review screen: a single coin
 * and every photo we think belongs to it.
 *
 * WHY THIS FILE EXISTS
 * The review screen has to answer one question per coin: "are these the right
 * photos for this coin?" A flat list of 1,700 filenames cannot answer it. So
 * the unit of review is the coin, and this component is that unit.
 *
 * TWO THINGS TO NOTICE
 *
 * 1. COLLAPSED BY DEFAULT.
 *    Thumbnails are real <img> tags pointing at real multi-megabyte JPEGs on a
 *    network share. Rendering all of them at once would decode gigabytes of
 *    pixel data and lock the tab. So a group shows only its counts until the
 *    user opens it, and the parent creates object URLs for just that group
 *    (see `expandRequested`). `loading="lazy"` then defers even those until
 *    they scroll into view.
 *
 * 2. THE PHOTOS ARE SORTED, NOT JUST LISTED.
 *    A coin often has 8-10 files: both faces, numbered retakes, "- Small" /
 *    "- Orig" / "- Sharpened" derivatives and a slab "- Label" shot. They are
 *    grouped Obverse / Reverse / Label / Other so the two that matter are
 *    always first, and the bulk buttons let the user clear the rest in one
 *    click instead of ten.
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

  /**
   * Lazily-created object URLs, keyed by filename. Owned by the parent so the
   * URLs can be revoked when the modal closes — a blob URL that is never
   * revoked keeps the whole file alive in memory for the life of the tab.
   */
  readonly thumbnailUrls = input<Record<string, string>>({});

  /** The user clicked the header; the parent should create thumbnails. */
  readonly expandToggled = output<string>();

  /** A single tick-box changed. Emits the filename. */
  readonly rowToggled = output<string>();

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

  /**
   * The short caption under each thumbnail: "Obverse", "Obverse · Small",
   * "Reverse · take 2". Enough to tell near-identical shots apart without
   * showing the whole filename, which is often 60 characters long.
   */
  protected caption(row: BatchImageRow): string {
    const parts = [sideLabel(row.photo.side)];
    if (row.photo.variant) parts.push(row.photo.variant);
    if (row.photo.takeNumber !== null && row.photo.takeNumber >= 2) {
      parts.push(`take ${row.photo.takeNumber}`);
    }
    return parts.join(' · ');
  }

  /** Original file size, e.g. "2.4 MB" — makes the 46 MB monsters obvious. */
  protected fileSize(row: BatchImageRow): string {
    if (!row.sizeBytes) return '';
    const mb = row.sizeBytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`;
  }
}
