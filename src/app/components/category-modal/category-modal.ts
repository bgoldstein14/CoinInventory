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

  protected readonly newCategoryOption = signal<string>('');
  protected readonly newCoinSet = signal<string>('');

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
}
