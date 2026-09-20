import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { formatDenominationDisplay } from '../../types/inventory-columns';

/**
 * CoinEditorForm — the grid of editable fields inside the detail sidebar
 * (year, denomination, grade, prices, certification, notes, and so on).
 *
 * WHY THIS FILE EXISTS
 * This is the single biggest chunk of markup in the app. Keeping it apart from
 * CoinDetailPanel means the panel stays a readable twenty-line frame, and all
 * the "how do I display a price in a text box" plumbing lives in one obvious
 * place.
 *
 * HOW SAVING WORKS
 * There is no Save button. Every field writes straight back to the coin via
 * `InventoryService.updateCoin()`, which debounces and batches the changes
 * before sending them to the server. That is why each control is bound with a
 * one-way `[ngModel]` plus an explicit `(ngModelChange)` handler rather than
 * two-way `[(ngModel)]`: the coin record is the single source of truth, and the
 * input is only ever a view of it.
 */
@Component({
  selector: 'app-coin-editor-form',
  imports: [FormsModule],
  templateUrl: './coin-editor-form.html',
  styleUrl: './coin-editor-form.scss'
})
export class CoinEditorForm {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /** The coin being edited. */
  readonly coin = input.required<CoinRecord>();

  /** Signals for custom "Other" denomination and mint mark inputs */
  protected readonly customDenominationValue = signal<string>('');
  protected readonly customMintMarkValue = signal<string>('');

  /** The Metal dropdown's options, kept in sync with the database lookup list. */
  protected readonly metalContentOptions = this.inventoryService.metalContents;

  protected formatDenominationDisplay = formatDenominationDisplay;

  /** Exposed so the template can coerce number inputs, e.g. `Number($event)`. */
  protected readonly Number = Number;

  /**
   * Write one field back to the coin.
   *
   * Certification companies are short codes (NGC, PCGS, ANACS...), so that one
   * field is trimmed to five characters and upper-cased as you type.
   */
  protected updateSelectedCoin<K extends keyof CoinRecord>(field: K, value: CoinRecord[K]): void {
    const coin = this.coin();

    let nextValue = value;
    if (field === 'certCompany') {
      nextValue = String(value ?? '').slice(0, 5).toUpperCase() as CoinRecord[K];
    }

    this.inv.updateCoin(coin.id, { [field]: nextValue } as Partial<CoinRecord>);
  }

  /** Displays a stored number as "$1,234.56" in a plain text input. */
  protected formatMoneyInput(value: number | null | undefined): string {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) return '$0.00';
    return `$${numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /** Turns whatever the user typed ("$1,234.56", "1234.56") back into a number. */
  protected parseMoneyInput(value: string): number {
    const numeric = Number(String(value ?? '').replace(/[$,]/g, '').trim());
    return Number.isFinite(numeric) ? numeric : 0;
  }

  /** Coin weights are conventionally shown to three decimal places. */
  protected formatWeightInput(value: number | null | undefined): string {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) return '0.000';
    return numeric.toFixed(3);
  }

  protected parseWeightInput(value: string): number {
    const numeric = Number(String(value ?? '').trim());
    return Number.isFinite(numeric) ? numeric : 0;
  }

  /** The CAC "green bean" sticker is a simple yes/no on the coin. */
  protected toggleCacSticker(): void {
    const coin = this.coin();
    this.inv.updateCoin(coin.id, { hasCacSticker: !coin.hasCacSticker });
  }
}
