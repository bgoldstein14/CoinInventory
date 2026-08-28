import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';

@Component({
  selector: 'app-category-modal',
  imports: [FormsModule],
  templateUrl: './category-modal.html',
  styleUrl: './category-modal.scss'
})
export class CategoryModal {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();

  // Signals for draft input values
  protected readonly newCategoryOption = signal<string>('');
  protected readonly newCoinSet = signal<string>('');
  protected readonly newDenominationLabel = signal<string>('');
  protected readonly newDenominationCountry = signal<string>('US');
  protected readonly newMintMarkLabel = signal<string>('');
  protected readonly newMintMarkDescription = signal<string>('');

  addCategoryOptionFromDraft(): void {
    const draft = this.newCategoryOption().trim();
    if (!draft) return;
    this.inv.mergeCategoryOptions([draft]);
    this.newCategoryOption.set('');
  }

  removeCategoryOption(category: string): void {
    this.inv.removeCategoryOption(category);
  }

  addCoinSetFromDraft(): void {
    const draft = this.newCoinSet().trim();
    if (!draft) return;
    this.inv.addCoinSet(draft);
    this.newCoinSet.set('');
  }

  removeCoinSet(name: string): void {
    this.inv.removeCoinSet(name);
  }

  // ========== Denomination Management ==========

  /**
   * Add a new denomination from the draft input.
   * Requires database connection (database mode).
   */
  async addDenominationFromDraft(): Promise<void> {
    const label = this.newDenominationLabel().trim();
    const country = this.newDenominationCountry().trim();
    if (!label || !country) return;

    // Calculate sort order: put new denomination at the end
    const maxSortOrder = Math.max(0, ...this.inv.denominations().map(d => d.sortOrder));

    await this.inv.addDenomination({
      label,
      country,
      sortOrder: maxSortOrder + 10,
      isActive: true
    });

    // Clear the draft input after successful add
    this.newDenominationLabel.set('');
    this.newDenominationCountry.set('US');
  }

  /**
   * Remove a denomination by ID.
   * Requires database connection (database mode).
   */
  async removeDenomination(denominationId: number): Promise<void> {
    await this.inv.removeDenomination(denominationId);
  }

  // ========== Mint Mark Management ==========

  /**
   * Add a new mint mark from the draft input.
   * Requires database connection (database mode).
   */
  async addMintMarkFromDraft(): Promise<void> {
    const label = this.newMintMarkLabel().trim();
    const description = this.newMintMarkDescription().trim();
    if (!label || !description) return;

    await this.inv.addMintMark({
      label,
      description,
      isActive: true
    });

    // Clear the draft input after successful add
    this.newMintMarkLabel.set('');
    this.newMintMarkDescription.set('');
  }

  /**
   * Remove a mint mark by ID.
   * Requires database connection (database mode).
   */
  async removeMintMark(mintMarkId: number): Promise<void> {
    await this.inv.removeMintMark(mintMarkId);
  }
}
