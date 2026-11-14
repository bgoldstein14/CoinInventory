import {
  AfterViewInit, Component, ElementRef, OnChanges, computed, inject, input, output
} from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import {
  DraftRowStatus, describeDraftRow
} from '../../services/inventory/draft-row-status';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { CoinEditorForm } from '../coin-editor-form/coin-editor-form';
import { firstEditableField } from './first-editable-field';

/**
 * CoinDetailPanel — the sidebar that opens when you click "Details" on a row.
 *
 * This component owns the *frame* around a single coin: the Show images /
 * Close / Delete buttons, the draft note, and putting the caret in the first
 * field. Everything editable — including the optional Transactions section,
 * which has to sit directly above the coin's Notes box — is a component of
 * its own, CoinEditorForm.
 *
 * The panel deliberately does not decide anything: closing and deleting are
 * emitted upwards, because the App shell also has to hide the panel and tidy
 * up the image gallery when either happens.
 */
@Component({
  selector: 'app-coin-detail-panel',
  imports: [CoinEditorForm],
  templateUrl: './coin-detail-panel.html',
  styleUrl: './coin-detail-panel.scss'
})
export class CoinDetailPanel implements AfterViewInit, OnChanges {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /**
   * The panel's own element, used for ONE thing: putting the caret in the
   * first field when "Add Coin" opens the panel on a brand new row.
   *
   * `optional: true` because app.spec.ts builds this component from a bare
   * `Injector.create` that provides only InventoryService.
   */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef, { optional: true });

  /** The coin being shown. The App shell only renders the panel when one exists. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, so the "Show images" button can open the gallery. */
  readonly images = input.required<CoinImagesStore>();

  /**
   * Settings > "Show transactions section in details".
   *
   * Read by NOTHING in this class — it is passed straight down to
   * CoinEditorForm, because the section it gates has to render between two
   * of that component's own children. Kept as an input here so the App
   * shell's binding, and the setting behind it, are unchanged.
   */
  readonly showTransactions = input.required<boolean>();

  /**
   * "PUT THE CARET IN THE FIRST FIELD" — bumped by the shell each time Add
   * Coin creates a row.
   *
   * A COUNTER, NOT A BOOLEAN. Two Add Coin presses in a row must each move
   * the caret, and a boolean that is already `true` the second time changes
   * nothing, so nothing would happen. Zero means "never asked".
   *
   * Only Add Coin sets it. Opening the panel by clicking or keying a row
   * deliberately does NOT: that would throw focus out of the grid, and the
   * arrow keys would stop working the moment the panel appeared.
   */
  readonly focusFirstFieldRequest = input(0);

  readonly closeRequested = output<void>();
  readonly deleteRequested = output<void>();

  /** The highest `focusFirstFieldRequest` that has actually moved the caret. */
  private lastFocusedRequest = 0;

  /*
   * TWO HOOKS FOR ONE JOB, and both are needed.
   *
   * `ngOnChanges` fires when the shell bumps the counter while the panel is
   * ALREADY OPEN — Add Coin pressed with a coin on screen. `ngAfterViewInit`
   * fires when the panel was closed and has just been created, where
   * ngOnChanges runs before the form below exists and so finds no field to
   * focus.
   *
   * `applyPendingFocus` only records the request as handled once it has
   * actually focused something, which is what lets the early, fruitless
   * ngOnChanges pass fall through to ngAfterViewInit instead of swallowing
   * the request.
   */
  ngAfterViewInit(): void { this.applyPendingFocus(); }
  ngOnChanges(): void { this.applyPendingFocus(); }

  private applyPendingFocus(): void {
    const request = this.focusFirstFieldRequest();
    if (request <= 0 || request === this.lastFocusedRequest) return;

    const root = this.host?.nativeElement;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const field = firstEditableField(
      Array.from(root.querySelectorAll<HTMLElement>('input, select, textarea'))
    );
    if (!field) return;

    this.lastFocusedRequest = request;
    field.focus?.();
  }

  /**
   * WHAT THIS ROW STILL NEEDS, SAID IN PLACE.
   *
   * A coin that is still being typed is an expected state, so the panel the
   * user is typing into says what to type next, calmly, where they are
   * looking. It must never be a red error toast — `showError` is reserved
   * for a save that was attempted and REFUSED, which `describeDraftRow`
   * reports separately as `failed`.
   *
   * Null for a coin that is in the database, which is almost every coin.
   *
   * `isDraftCoin` and `draftHint` are read defensively because several specs
   * build this panel against a minimal InventoryService stub.
   */
  protected readonly draftStatus = computed<DraftRowStatus | null>(() => {
    const coin = this.coin();
    const isDraft = this.inv.isDraftCoin;
    if (typeof isDraft !== 'function' || !isDraft.call(this.inv, coin.id)) return null;

    const hint = this.inv.draftHint;
    const lastAttempt = typeof hint === 'function' ? hint.call(this.inv, coin) : '';
    return describeDraftRow(coin, { lastAttempt });
  });

}
