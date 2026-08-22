import { Component, computed, inject, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { InventoryService } from '../../services/inventory.service';

@Component({
  selector: 'app-report-modal',
  imports: [DecimalPipe],
  templateUrl: './report-modal.html',
  styleUrl: './report-modal.scss'
})
export class ReportModal {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();
  readonly exportCsvRequested = output<void>();
  readonly exportInsuranceCsvRequested = output<void>();

  protected readonly reportStats = computed(() => {
    const inv = this.inv.inventory();
    const totalCost = inv.reduce((s, c) => s + c.purchasePrice, 0);
    const totalValue = inv.reduce((s, c) => s + c.currentValue, 0);
    const sold = inv.filter(c => (c.soldPrice ?? 0) > 0);
    const totalSold = sold.reduce((s, c) => s + (c.soldPrice ?? 0), 0);
    const graded = inv.filter(c => c.certCompany);
    const withImages = inv.filter(c => c.imagePaths.length > 0);
    const byCategory: Record<string, { count: number; value: number }> = {};
    for (const c of inv) {
      const cat = c.category || '(none)';
      byCategory[cat] ??= { count: 0, value: 0 };
      byCategory[cat].count++;
      byCategory[cat].value += c.currentValue;
    }
    const byDenomination: Record<string, { count: number; value: number }> = {};
    for (const c of inv) {
      const denom = c.denomination || '(none)';
      byDenomination[denom] ??= { count: 0, value: 0 };
      byDenomination[denom].count++;
      byDenomination[denom].value += c.currentValue;
    }
    return {
      totalCoins: inv.length, totalCost, totalValue,
      totalProfit: totalValue - totalCost,
      soldCount: sold.length, totalSold,
      gradedCount: graded.length,
      withImagesCount: withImages.length,
      byCategory: Object.entries(byCategory).sort((a, b) => b[1].value - a[1].value),
      byDenomination: Object.entries(byDenomination).sort((a, b) => b[1].value - a[1].value)
    };
  });
}
