import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppSettings } from '../../features/app-settings';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { formatDenominationDisplay } from '../../types/inventory-columns';

/**
 * SettingsModal — the Settings dialog: one display preference plus the four
 * editable reference lists (categories, denominations, mint marks, metals).
 *
 * WHY THIS FILE EXISTS
 * Reference-list maintenance was roughly a third of the App component: eight
 * signals, ten add/remove methods, and the text <-> list parsing that backs the
 * big textareas. None of it is needed until the user opens Settings, and none
 * of it is interesting to anything else on the page.
 *
 * HOW THE TWO EDITING STYLES FIT TOGETHER
 * Each list can be edited two ways: the chips (click a chip to delete it, or
 * type in the little box and press Add) apply immediately, while the textarea
 * underneath is a bulk editor that is only applied when you press Save. That is
 * why every immediate action calls populateSettingsText() afterwards — it
 * refreshes the textareas so they never show a stale copy of the list.
 *
 * The component is created fresh each time the dialog opens (the App shell
 * wraps it in an `@if`), so the constructor is the right place to fill in the
 * textareas.
 */
@Component({
  selector: 'app-settings-modal',
  imports: [FormsModule],
  templateUrl: './settings-modal.html',
  styleUrl: './settings-modal.scss'
})
export class SettingsModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly storageService = inject(StorageService);
  protected get inv() { return this.inventoryService; }

  /** Current value of the "show transactions" preference, owned by the App shell. */
  readonly showTransactionsInDetails = input.required<boolean>();

  /** Emitted as soon as the checkbox is ticked (the App shell keeps the value). */
  readonly showTransactionsInDetailsChange = output<boolean>();

  readonly closed = output<void>();

  // --- "Add one item" inputs, one per list ---
  protected readonly categoryDraft = signal('');
  protected readonly denominationDraft = signal('');
  protected readonly mintMarkDraft = signal('');
  protected readonly metalContentDraft = signal('');

  // --- Bulk-edit textareas: the same lists as newline-separated text ---
  protected readonly categoryListText = signal('');
  protected readonly denominationListText = signal('');
  protected readonly mintMarkListText = signal('');
  protected readonly metalContentListText = signal('');

  constructor() {
    this.populateSettingsText();
  }

  // ===================== Save =====================

  /**
   * Applies the four textareas back onto the reference lists and stores the
   * display preference, then closes the dialog.
   *
   * Mint marks and denominations are richer records than plain strings, so the
   * text lines are rebuilt into objects here. Ids and sort orders are simply
   * re-numbered from the order of the lines.
   */
  protected saveSettings(): void {
    this.inv.categoryOptions.set(this.parseTextList(this.categoryListText()));
    this.inv.metalContents.set(this.parseTextList(this.metalContentListText()));
    this.inv.mintMarks.set(this.parseTextList(this.mintMarkListText()).map((label, index) => ({
      mintMarkId: index + 1,
      label,
      description: label,
      isActive: true
    })));
    this.inv.denominations.set(this.parseTextList(this.denominationListText()).map((label, index) => ({
      denominationId: index + 1,
      label,
      country: 'United States',
      sortOrder: index + 1,
      isActive: true
    })));

    const settings: AppSettings = {
      showTransactionsInDetails: this.showTransactionsInDetails()
    };

    this.storageService.set(StorageKeys.AppSettings, settings);
    this.closed.emit();
  }

  // ===================== Categories =====================

  protected addCategory(): void {
    const draft = this.categoryDraft().trim();
    if (!draft) return;
    this.inv.mergeCategoryOptions([draft]);
    this.categoryDraft.set('');
    this.populateSettingsText();
  }

  protected removeCategory(category: string): void {
    this.inv.removeCategoryOption(category);
    this.populateSettingsText();
  }

  // ===================== Denominations =====================

  protected addDenomination(): void {
    const label = this.denominationDraft().trim();
    if (!label) return;

    // Put the new denomination at the end of the sort order, leaving a gap of
    // 10 so future entries can be slotted in between without renumbering.
    const nextSortOrder = Math.max(0, ...this.inv.denominations().map(d => d.sortOrder)) + 10;
    void this.inv.addDenomination({
      label,
      country: 'United States',
      sortOrder: nextSortOrder,
      isActive: true
    });

    this.denominationDraft.set('');
    this.populateSettingsText();
  }

  protected removeDenominationEntry(id: number): void {
    void this.inv.removeDenomination(id);
    this.populateSettingsText();
  }

  // ===================== Mint marks =====================

  protected addMintMark(): void {
    const label = this.mintMarkDraft().trim();
    if (!label) return;

    void this.inv.addMintMark({
      label,
      description: label,
      isActive: true
    });

    this.mintMarkDraft.set('');
    this.populateSettingsText();
  }

  protected removeMintMarkEntry(id: number): void {
    void this.inv.removeMintMark(id);
    this.populateSettingsText();
  }

  // ===================== Metal content =====================

  protected addMetalContent(): void {
    const value = this.metalContentDraft().trim();
    if (!value) return;

    const next = [...new Set([...this.inv.metalContents(), value])].sort((left, right) => left.localeCompare(right));
    this.inv.metalContents.set(next);
    this.metalContentDraft.set('');
    this.populateSettingsText();
  }

  protected removeMetalContent(value: string): void {
    this.inv.metalContents.set(this.inv.metalContents().filter(item => item !== value));
    this.populateSettingsText();
  }

  // ===================== Textarea plumbing =====================

  protected updateCategoryListText(value: string): void {
    this.categoryListText.set(value);
  }

  protected updateDenominationListText(value: string): void {
    this.denominationListText.set(value);
  }

  protected updateMintMarkListText(value: string): void {
    this.mintMarkListText.set(value);
  }

  protected updateMetalContentListText(value: string): void {
    this.metalContentListText.set(value);
  }

  /** Refills all four textareas from the live reference lists. */
  private populateSettingsText(): void {
    this.categoryListText.set(this.inv.categoryOptions().join('\n'));
    this.denominationListText.set(this.inv.denominations().map(d => formatDenominationDisplay(d.label)).join('\n'));
    this.mintMarkListText.set(this.inv.mintMarks().map(m => m.label).join('\n'));
    this.metalContentListText.set(this.inv.metalContents().join('\n'));
  }

  /**
   * Turns textarea contents into a clean list: split on newlines or commas,
   * trim, drop blanks, de-duplicate, then sort naturally (so "Item 2" comes
   * before "Item 10").
   */
  private parseTextList(value: string): string[] {
    return [...new Set(value
      .split(/\r?\n|,/)
      .map(item => item.trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }
}
