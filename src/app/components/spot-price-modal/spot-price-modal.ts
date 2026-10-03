import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { InventoryService } from '../../services/inventory.service';
import { SpotPriceService } from '../../services/spot-price.service';
import { SpotPrices } from '../../types/coin.model';

/** Provenance label recorded against hand-typed prices. */
const MANUAL_SOURCE = 'Manual entry';

/**
 * SpotPriceModalComponent — the "Spot Prices" dialog.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND BEFORE EDITING THIS FILE
 * ---------------------------------------------------------------------------
 * `POST /api/spot-prices` does not update a price. It INSERTS A NEW ROW into a
 * price-history table, every single time it is called, for ever. (Read
 * server/routes/data/spot-prices.ts if you want to see it.)
 *
 * The four inputs below are bound with `(ngModelChange)`, which fires on every
 * keystroke. Typing "2650" into the Gold box fires it four times; nudging it
 * with the arrow keys fires it once per press. So if saving were wired into
 * the price setter, a single price change would litter the table with a dozen
 * rows and the next start-up would read back whichever half-typed number
 * happened to land last.
 *
 * Hence the split, which is the whole design of this component:
 *
 *   inv.updateSpotPrices()   in-memory only. Called freely, per keystroke.
 *                            Every melt value on screen updates instantly
 *                            because they all read the same signal.
 *
 *   inv.commitSpotPrices()   writes ONE history row. Called from exactly two
 *                            deliberate user actions, and nowhere else:
 *
 *       1. a successful "Fetch COMEX Prices" — the user asked for fresh
 *          prices and got them; that is a real event worth recording; and
 *       2. closing the dialog after hand-editing — one row for the editing
 *          session, written when the user is finished rather than while they
 *          are still typing. `manualEditsPending` below is what makes it
 *          "after hand-editing" rather than "every time the dialog closes":
 *          opening the dialog and closing it again writes nothing.
 *
 * InventoryService.commitSpotPrices() adds two more guards of its own (it
 * skips a save whose prices match the last row written, and skips an all-zero
 * set), so even a mistaken extra call cannot produce a junk row.
 */
@Component({
  selector: 'app-spot-price-modal',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './spot-price-modal.html',
  styleUrl: './spot-price-modal.scss',
})
export class SpotPriceModalComponent {
  private readonly inventoryService = inject(InventoryService);
  private readonly spotPriceService = inject(SpotPriceService);

  readonly closed = output<void>();

  protected readonly spotPriceFetching = signal(false);
  protected readonly spotPriceError = signal<string>('');

  /**
   * Has the user hand-edited a price since the dialog opened?
   *
   * This is the flag that turns "the dialog closed" into "the user committed
   * manual edits". Without it, every open-and-close would add a history row
   * of prices nobody changed.
   *
   * A successful fetch clears it, because the fetch has already saved.
   */
  protected readonly manualEditsPending = signal(false);

  /**
   * Where the prices on screen came from and when they were saved.
   *
   * Read straight off InventoryService rather than kept locally, so the
   * dialog shows the provenance of prices LOADED AT START-UP, not just ones
   * fetched in this session. Before this, reopening the app showed an empty
   * fetch bar as though nothing had ever been retrieved.
   */
  protected readonly savedSource = computed(() => this.inv.spotPriceMeta().source);
  protected readonly savedAt = computed(() => this.inv.spotPriceMeta().fetchedAt);

  /**
   * True when there is not a single non-zero price anywhere.
   *
   * Drives the "nothing loaded yet" note. It is the difference between a melt
   * column full of dashes because the price table is empty — two clicks from
   * being fixed — and one full of dashes because the coins are base metal.
   */
  protected readonly noPricesYet = computed(() => !this.inv.hasSpotPrices());

  protected readonly Number = Number;

  protected get inv() {
    return this.inventoryService;
  }

  /**
   * A price box changed. In-memory ONLY — see the class comment. The melt
   * figures in the grid behind the dialog move as you type; nothing is
   * written to the database until you close.
   */
  protected updateSpotPrice(metal: keyof SpotPrices, value: number): void {
    // A ZERO IS NOT A PRICE. No metal trades at zero, so an empty box, a
    // half-typed "-" (which arrives as NaN) or a literal 0 all mean the same
    // thing here: "I have no price for this metal". They are normalised to 0,
    // which is the value computeMeltValue() already reads as "cannot say" and
    // renders as "—" rather than "$0.00".
    //
    // Leaving one metal blank is a perfectly normal thing to do and does NOT
    // stop the others being saved: commitSpotPrices() only refuses when ALL
    // FOUR are zero, because that set carries no information at all.
    const price = Number.isFinite(value) && value > 0 ? value : 0;
    this.inv.updateSpotPrices({ ...this.inv.spotPrices(), [metal]: price });
    this.manualEditsPending.set(true);
  }

  /**
   * Deliberate action #1: fetch live COMEX prices and, if that worked, record
   * them. The save is awaited but cannot fail loudly — commitSpotPrices()
   * swallows errors into a warning, so a database hiccup still leaves the
   * freshly fetched prices usable for this session.
   */
  protected async fetchSpotPrices(): Promise<void> {
    this.spotPriceFetching.set(true);
    this.spotPriceError.set('');
    const result = await this.spotPriceService.fetchSpotPrices();
    this.spotPriceFetching.set(false);

    if (result.error) {
      this.spotPriceError.set(result.error);
      return;
    }

    this.inv.updateSpotPrices(result.prices);

    // Anything the user typed before pressing Fetch has just been replaced,
    // and the line below saves the replacement, so there is nothing pending.
    this.manualEditsPending.set(false);
    await this.inv.commitSpotPrices(result.source);
  }

  /**
   * Deliberate action #2: the user is finished. Save hand-typed prices once,
   * here, rather than once per keystroke on the way in.
   *
   * Every way out of the dialog — the × button, the Done button and a click
   * on the backdrop — routes through this method, so there is no exit that
   * quietly loses an edit.
   */
  protected async close(): Promise<void> {
    if (this.manualEditsPending()) {
      this.manualEditsPending.set(false);
      await this.inv.commitSpotPrices(MANUAL_SOURCE);
    }
    this.closed.emit();
  }
}
