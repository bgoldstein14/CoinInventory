import { Component, input } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { CoinRecord } from '../../types/coin.model';

/**
 * CoinPhotoViewer — the full-screen "lightbox" you get by clicking a thumbnail
 * in the gallery, with previous / next / close controls.
 *
 * WHY THIS FILE EXISTS
 * It is a completely separate overlay from the gallery (different z-index,
 * different backdrop, different keyboard affordances), so it gets its own
 * component. Which photo is showing lives in CoinImagesStore, shared with the
 * gallery that opened it.
 */
@Component({
  selector: 'app-coin-photo-viewer',
  imports: [],
  templateUrl: './coin-photo-viewer.html',
  styleUrl: './coin-photo-viewer.scss'
})
export class CoinPhotoViewer {
  /** The coin whose photos are being browsed. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, owned by the App shell. */
  readonly images = input.required<CoinImagesStore>();
}
