import { describe, expect, it } from 'vitest';
import { inventoryColumnOrder } from './inventory-columns';

describe('inventoryColumnOrder', () => {
  it('places Mint Mark immediately after Year', () => {
    expect(inventoryColumnOrder.indexOf('year')).toBeLessThan(inventoryColumnOrder.indexOf('mintMark'));
    expect(inventoryColumnOrder.indexOf('mintMark') - inventoryColumnOrder.indexOf('year')).toBe(1);
  });
});
