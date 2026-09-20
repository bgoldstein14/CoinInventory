/**
 * db/coin-fields.spec.ts — guards COIN_FIELDS against schema drift.
 *
 * ============================================================
 * Parameter types vs. the SQL schema
 * ============================================================
 *
 * Declaring a parameter shorter than its column silently truncates the user's
 * data; declaring it longer makes SQL Server raise error 8152 and abort the
 * transaction. Both were happening. These tests read setup-database.sql and
 * fail if COIN_FIELDS ever drifts away from it again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../test-support/mssql-mock');
  return createMssqlMock();
});

import { resetMssqlMock } from '../test-support/mssql-mock';
import { COIN_FIELDS } from './index';

beforeEach(() => {
  resetMssqlMock();
});

describe('COIN_FIELDS matches setup-database.sql', () => {
  // setup-database.sql lives one level up, in the server/ root.
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'setup-database.sql'), 'utf8');
  const coinsBlock = schemaSql.match(/CREATE TABLE Coins \(([\s\S]*?)\n\);/)?.[1] ?? '';

  /** column name -> { type, length } parsed straight out of the DDL. */
  const schemaColumns = new Map<string, { type: string; length?: number }>();
  for (const line of coinsBlock.split('\n')) {
    const match = line.match(/^\s*(\w+)\s+(NVARCHAR|DECIMAL|BIT|INT|UNIQUEIDENTIFIER)\s*(?:\(\s*([^)]*?)\s*\))?/i);
    if (!match) continue;
    const [, column, rawType, rawArgs] = match;
    const firstArg = rawArgs?.split(',')[0]?.trim();
    schemaColumns.set(column, {
      type: rawType.toUpperCase(),
      length: firstArg && /^\d+$/.test(firstArg) ? Number(firstArg) : undefined,
    });
  }

  it('parsed the Coins table out of the schema file', () => {
    expect(schemaColumns.size).toBeGreaterThan(20);
    expect(schemaColumns.get('Year')).toEqual({ type: 'NVARCHAR', length: 50 });
  });

  it('declares every NVARCHAR parameter at exactly the schema length', () => {
    const mismatches: string[] = [];

    for (const [key, binding] of Object.entries(COIN_FIELDS)) {
      const schemaColumn = schemaColumns.get(binding.column);
      if (!schemaColumn) {
        mismatches.push(`${key}: column ${binding.column} is not in setup-database.sql`);
        continue;
      }
      if (schemaColumn.type !== 'NVARCHAR') continue;

      if (binding.maxLength !== schemaColumn.length) {
        mismatches.push(
          `${key} (${binding.column}): route declares ${binding.maxLength ?? 'MAX'}, schema is ${schemaColumn.length ?? 'MAX'}`
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('keeps the historically wrong columns correct', () => {
    // These are the exact fields that were silently truncating or blowing up.
    expect(COIN_FIELDS['year'].maxLength).toBe(50);
    expect(COIN_FIELDS['grade'].maxLength).toBe(50);
    expect(COIN_FIELDS['certCompany'].maxLength).toBe(100);
    expect(COIN_FIELDS['mintMark'].maxLength).toBe(20);
    expect(COIN_FIELDS['source'].maxLength).toBe(50);
    expect(COIN_FIELDS['dealer'].maxLength).toBe(200);
    expect(COIN_FIELDS['coinSet'].maxLength).toBe(100);
  });

  it('binds the text-based date columns as text, not sql.Date', () => {
    // PurchaseDate / SoldDate are NVARCHAR(30) in the schema. Binding a JS Date
    // into them produced a locale-dependent string that would not round-trip.
    for (const key of ['purchaseDate', 'soldDate']) {
      expect(COIN_FIELDS[key].maxLength).toBe(30);
      expect(COIN_FIELDS[key].sqlType).toMatchObject({ type: 'nvarchar', length: 30 });
    }
  });
});
