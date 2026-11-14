/**
 * migrate-sqlserver/fixture-source-reader.ts — a SQL Server made of objects.
 *
 * The whole reason `SourceReader` is an interface. There is no SQL Server on
 * the machine this was built on, so the migration's real decisions are
 * exercised against this instead: a table is an array of rows, a column list
 * is an array of `SourceColumn`, and every spec can therefore describe a
 * half-migrated source, a source with the owner's own denominations in it, or
 * a source with a duplicated label, in four lines.
 *
 * It is a FIXTURE and not a simulator. It implements exactly the four
 * questions `SourceReader` asks and nothing else:
 *
 *   - it understands the two SELECT item shapes the tool builds (a bare
 *     column, and the lower-cased GUID conversion), because the choice
 *     between them is a decision worth testing;
 *   - it applies `orderBy` for the columns it is given;
 *   - it streams, in the sense that it calls `onRow` once per row, which is
 *     enough to prove a caller does not depend on getting an array back.
 *
 * It does not pretend to be SQL. A spec that needs something this cannot
 * express should change what the migration asks for, not teach this file to
 * parse T-SQL.
 */

import {
  buildSelect,
  type SourceColumn,
  type SourceQuery,
  type SourceReader,
  type SourceRow,
  type SourceValue,
} from './source-reader';

/** One table in the fake source. */
export interface FixtureTable {
  readonly columns: readonly SourceColumn[];
  readonly rows: readonly SourceRow[];
}

/** Shorthand for the common column shapes, so fixtures stay readable. */
export function textColumn(name: string, maxLength: number | null = 100): SourceColumn {
  return { name, dataType: 'nvarchar', maxLength, precision: null, scale: null };
}

export function intColumn(name: string): SourceColumn {
  return { name, dataType: 'int', maxLength: null, precision: 10, scale: 0 };
}

export function bitColumn(name: string): SourceColumn {
  return { name, dataType: 'bit', maxLength: null, precision: null, scale: null };
}

export function decimalColumn(name: string, precision: number, scale: number): SourceColumn {
  return { name, dataType: 'decimal', maxLength: null, precision, scale };
}

export function guidColumn(name: string): SourceColumn {
  return { name, dataType: 'uniqueidentifier', maxLength: null, precision: null, scale: null };
}

export function dateTimeColumn(name: string): SourceColumn {
  return { name, dataType: 'datetime2', maxLength: null, precision: null, scale: null };
}

/**
 * Builds a table from a column list and plain row objects, filling in any
 * column a row left out with NULL — which is what SQL Server would hand back
 * and what keeps a 30-column fixture row down to the three fields the test
 * is actually about.
 */
export function fixtureTable(
  columns: readonly SourceColumn[],
  rows: ReadonlyArray<Record<string, SourceValue>>
): FixtureTable {
  const filled = rows.map((row) => {
    const complete: SourceRow = {};
    for (const columnInfo of columns) {
      complete[columnInfo.name] = columnInfo.name in row ? row[columnInfo.name] : null;
    }
    return complete;
  });
  return { columns, rows: filled };
}

export class FixtureSourceReader implements SourceReader {
  readonly description = 'fixture source (no database)';

  /** Every statement the tool asked for, in order. Asserted on by specs. */
  readonly statements: string[] = [];

  private opened = false;
  private closed = false;

  constructor(private readonly tablesByName: Record<string, FixtureTable>) {}

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** True once `close()` has run. A spec can prove the tool let go. */
  get isClosed(): boolean {
    return this.closed;
  }

  async tables(): Promise<string[]> {
    this.assertOpen();
    return Object.keys(this.tablesByName);
  }

  async columns(table: string): Promise<SourceColumn[]> {
    this.assertOpen();
    return [...(this.tablesByName[table]?.columns ?? [])];
  }

  async count(table: string): Promise<number> {
    this.assertOpen();
    return this.table(table).rows.length;
  }

  async forEachRow(query: SourceQuery, onRow: (row: SourceRow) => void): Promise<number> {
    this.assertOpen();
    // Built even though it is not executed: it runs the identifier
    // validation, so a fixture-driven spec still catches a column name the
    // real reader would have refused to put in a statement.
    this.statements.push(buildSelect(query));

    const table = this.table(query.table);
    const ordered = [...table.rows];

    if (query.orderBy && query.orderBy.length > 0) {
      const keys = query.orderBy;
      ordered.sort((left, right) => {
        for (const key of keys) {
          const comparison = compareValues(left[key], right[key]);
          if (comparison !== 0) return comparison;
        }
        return 0;
      });
    }

    let seen = 0;
    for (const row of ordered) {
      const projected: SourceRow = {};
      for (const item of query.select) {
        const raw = row[item.alias];
        projected[item.alias] = item.expression.startsWith('LOWER(CONVERT(')
          ? typeof raw === 'string'
            ? raw.toLowerCase()
            : raw
          : raw;
      }
      seen += 1;
      onRow(projected);
    }
    return seen;
  }

  private table(name: string): FixtureTable {
    const table = this.tablesByName[name];
    if (!table) throw new Error(`fixture source has no table ${name}`);
    return table;
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error('fixture source was used before open()');
    if (this.closed) throw new Error('fixture source was used after close()');
  }
}

function compareValues(left: SourceValue, right: SourceValue): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left) < String(right) ? -1 : 1;
}
