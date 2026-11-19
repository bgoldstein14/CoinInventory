/**
 * Guards COIN_FIELDS against drift from db/schema.sql. SQLite enforces no
 * widths, so these declared lengths and scales are what db/bind-values.ts
 * enforces. Widths are read from the trailing `-- NVARCHAR(n)` comments via
 * test-support/schema-columns.ts.
 */

import { describe, it, expect } from 'vitest';

import '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { COIN_FIELDS } from './index';

describe('COIN_FIELDS matches db/schema.sql', () => {
  const schemaColumns = parseTable('Coins');

  it('parsed the Coins table out of the schema file', () => {
    expect(schemaColumns.size).toBeGreaterThan(20);
    expect(schemaColumns.get('Year')).toMatchObject({
      storage: 'TEXT',
      declared: 'NVARCHAR(50)',
      maxLength: 50,
    });
  });

  it('declares every NVARCHAR parameter at exactly the schema length', () => {
    const mismatches: string[] = [];

    for (const [key, binding] of Object.entries(COIN_FIELDS)) {
      const schemaColumn = schemaColumns.get(binding.column);
      if (!schemaColumn) {
        mismatches.push(`${key}: column ${binding.column} is not in db/schema.sql`);
        continue;
      }
      if (!schemaColumn.declared.startsWith('NVARCHAR')) continue;

      if (binding.maxLength !== schemaColumn.maxLength) {
        mismatches.push(
          `${key} (${binding.column}): binding declares ${binding.maxLength ?? 'MAX'}, schema is ${schemaColumn.maxLength ?? 'MAX'}`
        );
      }
      if (binding.sqlType.maxLength !== schemaColumn.maxLength) {
        mismatches.push(
          `${key} (${binding.column}): sqlType declares ${binding.sqlType.maxLength ?? 'MAX'}, schema is ${schemaColumn.maxLength ?? 'MAX'}`
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  /** A wrong scale is invisible in the data: the number still looks plausible. */
  it('declares every DECIMAL parameter at exactly the schema precision and scale', () => {
    const mismatches: string[] = [];

    for (const [key, binding] of Object.entries(COIN_FIELDS)) {
      const schemaColumn = schemaColumns.get(binding.column);
      if (!schemaColumn || !schemaColumn.declared.startsWith('DECIMAL')) continue;

      if (binding.sqlType.declared !== schemaColumn.declared) {
        mismatches.push(
          `${key} (${binding.column}): binding is ${binding.sqlType.declared}, schema is ${schemaColumn.declared}`
        );
      }
    }

    expect(mismatches).toEqual([]);
    // Guard against the loop above having found nothing to check.
    expect(COIN_FIELDS['weight'].sqlType.declared).toBe('DECIMAL(12,5)');
    expect(COIN_FIELDS['pmWeightGrams'].sqlType.declared).toBe('DECIMAL(12,5)');
    expect(COIN_FIELDS['pmPercent'].sqlType.declared).toBe('DECIMAL(5,2)');
    expect(COIN_FIELDS['purchasePrice'].sqlType.declared).toBe('DECIMAL(12,2)');
    expect(COIN_FIELDS['currentValue'].sqlType.declared).toBe('DECIMAL(12,2)');
    expect(COIN_FIELDS['soldPrice'].sqlType.declared).toBe('DECIMAL(12,2)');
  });

  it('keeps the historically wrong columns correct', () => {
    // Fields that previously truncated or failed.
    expect(COIN_FIELDS['year'].maxLength).toBe(50);
    expect(COIN_FIELDS['grade'].maxLength).toBe(50);
    expect(COIN_FIELDS['certCompany'].maxLength).toBe(100);
    expect(COIN_FIELDS['mintMark'].maxLength).toBe(20);
    expect(COIN_FIELDS['source'].maxLength).toBe(50);
    expect(COIN_FIELDS['coinSet'].maxLength).toBe(100);
  });

  it('no longer binds a coin-level dealer column', () => {
    // Coins.Dealer was dropped (migration 006); a leftover binding would name
    // a missing column. The counterparties are PurchasedFrom / SoldTo.
    expect(COIN_FIELDS['dealer']).toBeUndefined();
    expect(parseTable('Coins').has('Dealer')).toBe(false);
    expect(() => parseTable('Transactions')).toThrow(/no CREATE TABLE for Transactions/);
    expect(COIN_FIELDS['purchasedFrom'].column).toBe('PurchasedFrom');
    expect(COIN_FIELDS['soldTo'].column).toBe('SoldTo');
  });

  it('binds the deal’s note and the coin’s note to DIFFERENT columns', () => {
    // Adjacent in the UI; they must never name the same column.
    expect(COIN_FIELDS['notes'].column).toBe('Notes');
    expect(COIN_FIELDS['transactionNotes'].column).toBe('TransactionNotes');
    expect(COIN_FIELDS['notes'].column).not.toBe(COIN_FIELDS['transactionNotes'].column);
    expect(parseTable('Coins').has('Notes')).toBe(true);
    expect(parseTable('Coins').has('TransactionNotes')).toBe(true);
  });

  it('binds the text-based date columns as text, not as a date type', () => {
    // Date columns are text; a JS Date must be stored as 'YYYY-MM-DD'.
    for (const key of ['purchaseDate', 'soldDate']) {
      expect(COIN_FIELDS[key].maxLength).toBe(30);
      expect(COIN_FIELDS[key].sqlType).toMatchObject({ storage: 'text', maxLength: 30 });
      expect(schemaColumns.get(COIN_FIELDS[key].column)?.storage).toBe('TEXT');
    }
  });
});
