import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { cacGreenBeanIconPath } from '../../features/inventory/coin-icons';
import { imageSourcePaths } from '../../services/image-source-paths';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord, TransactionRecord } from '../../types/coin.model';
import { certBadgeLabel, formatDenominationDisplay, gradeBadgeClass } from '../../types/inventory-columns';
import { CoinEditorForm } from '../coin-editor-form/coin-editor-form';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * CoinDetailPanel — the sidebar that opens when you click "Details" on a row.
 *
 * WHY THIS FILE EXISTS
 * This component owns the *frame* around a single coin: its heading, the grade
 * / certification / CAC badges, the Show images / Close / Delete buttons, and
 * the optional transaction history. The (much larger) grid of editable fields
 * is a component of its own — see CoinEditorForm — so that neither file grows
 * past the point where you can read it in one sitting.
 *
 * The panel deliberately does not decide anything: closing and deleting are
 * emitted upwards, because the App shell also has to hide the panel and tidy
 * up the image gallery when either happens.
 */
@Component({
  selector: 'app-coin-detail-panel',
  imports: [DecimalPipe, CoinEditorForm, CoinImagePathLink],
  templateUrl: './coin-detail-panel.html',
  styleUrl: './coin-detail-panel.scss'
})
export class CoinDetailPanel {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /** The coin being shown. The App shell only renders the panel when one exists. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, so the "Show images" button can open the gallery. */
  readonly images = input.required<CoinImagesStore>();

  /** User preference from Settings: show the per-coin transaction history? */
  readonly showTransactions = input.required<boolean>();

  readonly closeRequested = output<void>();
  readonly deleteRequested = output<void>();

  // --- Constants and pure formatters the template calls ---
  protected readonly cacGreenBeanIconPath = cacGreenBeanIconPath;
  protected formatDenominationDisplay = formatDenominationDisplay;
  protected gradeBadgeClass = gradeBadgeClass;
  protected certBadgeLabel = certBadgeLabel;

  /** Exposed so the transaction form's template can coerce its text input. */
  protected readonly Number = Number;

  /* ---------------------------------------------------------------------
   * Original image files
   * ------------------------------------------------------------------- */

  /**
   * Do we know where ANY of this coin's photos came from? Decides whether the
   * quiet "no locations recorded" sentence is shown underneath the list.
   *
   * Reads the registry singleton DIRECTLY rather than through
   * CoinImagePathsService. That is on purpose: this component is constructed in
   * tests from a bare Injector that provides only InventoryService, so adding
   * an injected dependency here would break them. The registry needs no
   * injection at all (see services/image-source-paths.ts), and fetching is
   * triggered by CoinImagePathLink, which Angular always builds properly.
   */
  protected readonly anyPathRecorded = computed(() =>
    imageSourcePaths.hasAnyPathFor(this.coin().imagePaths)
  );

  /**
   * Records a purchase / sale / trade / appraisal against the selected coin.
   * Blank fields fall back to sensible defaults (today's date, zero amount)
   * so a half-filled form can never produce an invalid record.
   */
  addTransactionForSelectedCoin(type: TransactionRecord['type'], amount: number, dealer: string, date: string, notes: string): void {
    const coinId = this.inv.selectedCoinId();
    if (!coinId) return;
    this.inv.addTransaction({
      id: crypto.randomUUID(), coinId, type,
      date: date || new Date().toISOString().slice(0, 10),
      amount: amount || 0, dealer: dealer || '', notes: notes || ''
    });
  }

  deleteTransaction(txnId: string): void { this.inv.deleteTransaction(txnId); }
}
