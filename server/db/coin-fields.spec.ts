/**
 * db/coin-fields.spec.ts — guards COIN_FIELDS against schema drift.
 *
 * *** THIS TEST GOT MORE IMPORTANT WHEN THE ENGINE BECAME SQLITE, NOT LESS. ***
 *
 * Under SQL Server the declared lengths in COIN_FIELDS were a SECOND opinion:
 * the column itself enforced the width, and a binding that disagreed produced
 * either silent truncation (binding shorter) or error 8152 (binding longer).
 * Either way the database had the last word.
 *
 * SQLite enforces nothing. A column this file calls NVarChar(50) will hold
 * four thousand characters without complaint, so the binding table is no
 * longer a description of what the database does — it is the only thing that
 * does it (db/bind-values.ts). A drift here is not a disagreement any more,
 * it is a hole.
 *
 * So these tests read db/schema.sql and fail if COIN_FIELDS drifts away from
 * it. The widths live in that file as a trailing `-- NVARCHAR(50)` comment,
 * because writing `NVARCHAR(50)` as the SQLite column type would parse and
 * enforce nothing, which would mislead the next reader; see
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

  /**
   * The six columns design §4.1 singles out, plus the fourth decimal on
   * Copper. A scale that disagrees with the schema is the one kind of drift
   * nobody can see in the data: the number still looks like a coin weight.
   */
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
    // These are the exact fields that were silently truncating or blowing up.
    expect(COIN_FIELDS['year'].maxLength).toBe(50);
    expect(COIN_FIELDS['grade'].maxLength).toBe(50);
    expect(COIN_FIELDS['certCompany'].maxLength).toBe(100);
    expect(COIN_FIELDS['mintMark'].maxLength).toBe(20);
    expect(COIN_FIELDS['source'].maxLength).toBe(50);
    // `dealer` was one of these (bound at 255 against a 200-char column). The
    // whole coin-level dealer field has since been removed, column and all.
    expect(COIN_FIELDS['coinSet'].maxLength).toBe(100);
  });

  it('no longer binds a coin-level dealer column', () => {
    // Coins.Dealer was dropped (migration 006). A binding left behind here
    // would make every INSERT name a column that does not exist.
    //
    // Transactions.Dealer used to be the exception this test called out. The
    // table is gone too; the counterparty is now TWO coin fields, one per
    // side of the deal, and they are bound here like everything else.
    expect(COIN_FIELDS['dealer']).toBeUndefined();
    expect(parseTable('Coins').has('Dealer')).toBe(false);
    expect(() => parseTable('Transactions')).toThrow(/no CREATE TABLE for Transactions/);
    expect(COIN_FIELDS['purchasedFrom'].column).toBe('PurchasedFrom');
    expect(COIN_FIELDS['soldTo'].column).toBe('SoldTo');
  });

  it('binds the deal’s note and the coin’s note to DIFFERENT columns', () => {
    // The two boxes are adjacent in the detail panel. If these ever named
    // the same column the user’s coin description would be overwritten by a
    // line about a dealer’s premium, with a 200 response and nothing to see.
    expect(COIN_FIELDS['notes'].column).toBe('Notes');
    expect(COIN_FIELDS['transactionNotes'].column).toBe('TransactionNotes');
    expect(COIN_FIELDS['notes'].column).not.toBe(COIN_FIELDS['transactionNotes'].column);
    expect(parseTable('Coins').has('Notes')).toBe(true);
    expect(parseTable('Coins').has('TransactionNotes')).toBe(true);
  });

  it('binds the text-based date columns as text, not as a date type', () => {
    // PurchaseDate / SoldDate are NVARCHAR(30) in the schema. Binding a JS Date
    // into them produced a locale-dependent string that would not round-trip.
    for (const key of ['purchaseDate', 'soldDate']) {
      expect(COIN_FIELDS[key].maxLength).toBe(30);
      expect(COIN_FIELDS[key].sqlType).toMatchObject({ storage: 'text', maxLength: 30 });
      expect(schemaColumns.get(COIN_FIELDS[key].column)?.storage).toBe('TEXT');
    }
  });
});
