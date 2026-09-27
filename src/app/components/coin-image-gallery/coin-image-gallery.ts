import { Component, input } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * CoinImageGallery — the overlay listing every photo attached to the selected
 * coin, with buttons to add more, delete one, or enlarge one.
 *
 * WHY THIS FILE EXISTS
 * Photo management is a self-contained job with a surprising amount of plumbing
 * behind it (file pickers, drag-and-drop, base64 encoding). All of that lives
 * in CoinImagesStore; this component is just the markup that drives it.
 */
@Component({
  selector: 'app-coin-image-gallery',
  imports: [CoinImagePathLink],
  templateUrl: './coin-image-gallery.html',
  styleUrl: './coin-image-gallery.scss'
})
export class CoinImageGallery {
  /** The coin whose photos are being shown. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, owned by the App shell. */
  readonly images = input.required<CoinImagesStore>();

  // Note: the lazy fetch of the recorded file paths is triggered by the
  // CoinImagePathLink children (see that component), not from here — so this
  // component keeps needing nothing but its two inputs.
}
