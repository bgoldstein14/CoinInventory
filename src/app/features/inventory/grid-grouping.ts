/*
 * grid-grouping.ts — rules for folding the main grid into groups by a column.
 *
 * With no column chosen the grid is flat: one row per coin, no headings.
 *
 * Expansion is stored as a default plus the headings that differ from it,
 * not as a set of collapsed headings. A set can only name groups that were
 * on screen when it was built, so "Collapse all" under a search, or a group
 * created later by an import, would otherwise render open.
 *
 * Pure and DOM-free so it can be tested under Node.
 */
import { CoinRecord } from '../../types/coin.model';
import { CatalogOption, mainCatalogRefLabel } from '../../types/catalog-reference';
import { PickerDenomination } from '../../components/coin-editor-form/denomination-picker';
import { sumCurrentValue } from '../../services/inventory/inventory-metrics';
import {
  InventoryColumn,
  SortState,
  formatInventoryCell,
  inventoryColumnLabels,
  inventoryColumnOrder
} from '../../types/inventory-columns';
import { compareText } from './denomination-sort';

/**
 * The kind of value a column holds. Only text columns can be grouped by;
 * numeric columns would give one group per distinct value.
 * The Record is exhaustive so a new column without a kind fails the build.
 */
export type GroupingColumnKind = 'text' | 'numeric' | 'boolean';

export const GROUPING_COLUMN_KINDS: Record<InventoryColumn, GroupingColumnKind> = {
  // Year is stored as text ("1916-1945", "1878-S").
  year: 'text',
  mintMark: 'text',
  denomination: 'text',
  coinType: 'text',
  certNumber: 'text',
  grade: 'text',
  collectionStatus: 'text',
  category: 'text',
  country: 'text',
  purchasePrice: 'numeric',
  currentValue: 'numeric',
  meltValue: 'numeric',
  soldPrice: 'numeric',
  variety: 'text',
  catalogReference: 'text',
  coinSet: 'text',
  storageLocation: 'text',
  metalContent: 'text',
  weight: 'numeric',
  pmWeightGrams: 'numeric',
  pmPercent: 'numeric'
};

/**
 * May the grid be grouped by this column? Accepts any string because the
 * restore path passes stored values that may name a deleted column.
 */
export function isGroupableColumn(column: string | null | undefined): column is InventoryColumn {
  if (!column) return false;
  const kind = (GROUPING_COLUMN_KINDS as Record<string, GroupingColumnKind | undefined>)[column];
  return kind === 'text';
}

/** Column names for the Group by menu and empty bucket; abbreviated grid headers are spelled out. */
export const GROUPING_COLUMN_LABELS: Record<InventoryColumn, string> = {
  ...inventoryColumnLabels,
  denomination: 'Denomination',
  mintMark: 'Mint Mark'
};

/** One entry in the Group by menu. */
export interface GroupingOption {
  readonly column: InventoryColumn;
  readonly label: string;
}

/** The Group by menu in canonical column order, including hidden columns. */
export const GROUPING_OPTIONS: readonly GroupingOption[] = inventoryColumnOrder
  .filter(isGroupableColumn)
  .map(column => ({ column, label: GROUPING_COLUMN_LABELS[column] }));

/**
 * Which groups are open. `exceptions` holds the headings that do not follow
 * `collapsedByDefault`, keyed by heading text.
 */
export interface GroupExpansion {
  readonly collapsedByDefault: boolean;
  readonly exceptions: ReadonlySet<string>;
}

/** Every group collapsed. A newly chosen grouping starts here. */
export function collapseAllGroups(): GroupExpansion {
  return { collapsedByDefault: true, exceptions: new Set<string>() };
}

/** Every group open, including ones not currently on screen. */
export function expandAllGroups(): GroupExpansion {
  return { collapsedByDefault: false, exceptions: new Set<string>() };
}

export function isGroupExpanded(state: GroupExpansion, heading: string): boolean {
  return state.exceptions.has(heading) ? state.collapsedByDefault : !state.collapsedByDefault;
}

export function toggleGroup(state: GroupExpansion, heading: string): GroupExpansion {
  const exceptions = new Set(state.exceptions);
  if (!exceptions.delete(heading)) exceptions.add(heading);
  return { collapsedByDefault: state.collapsedByDefault, exceptions };
}

/** How many of these groups are open. */
export function expandedGroupCount(
  state: GroupExpansion,
  headings: readonly string[]
): number {
  return headings.reduce((count, heading) => count + (isGroupExpanded(state, heading) ? 1 : 0), 0);
}

/** State of the single Expand all / Collapse all toggle. */
export interface ExpandAllControl {
  /** What pressing it does; the caller passes this back to applyExpandAllControl. */
  readonly action: 'expand' | 'collapse';
  readonly label: string;
  /** Longer form for `aria-label` and the tooltip. */
  readonly ariaLabel: string;
}

/** One toggle rather than two buttons: offers Collapse if any group is open, otherwise Expand. */
export function describeExpandAllControl(
  state: GroupExpansion,
  headings: readonly string[]
): ExpandAllControl {
  const total = headings.length;

  if (expandedGroupCount(state, headings) > 0) {
    return {
      action: 'collapse',
      label: 'Collapse all',
      ariaLabel: `Collapse all ${total} group(s)`
    };
  }

  return {
    action: 'expand',
    label: 'Expand all',
    ariaLabel: `Expand all ${total} group(s)`
  };
}

export function applyExpandAllControl(action: 'expand' | 'collapse'): GroupExpansion {
  return action === 'collapse' ? collapseAllGroups() : expandAllGroups();
}

/**
 * The placeholder an empty grid cell renders. Group keys are taken from the
 * formatted cell so headings always match the column text below them.
 */
const UNKNOWN_CELL = '—';

/**
 * Label for the bucket of coins with no value, e.g. "(No Country)".
 * Parenthesised so it can't be mistaken for a real value; sorted last.
 */
export function emptyGroupLabel(column: InventoryColumn): string {
  return `(No ${GROUPING_COLUMN_LABELS[column]})`;
}

/** One group of coins, rendered as a heading plus its rows. */
export interface CoinGroup {
  /** Heading text; also the key for expansion state. */
  readonly label: string;
  /** True for the "no value recorded" bucket. */
  readonly isEmptyBucket: boolean;
  readonly coins: readonly CoinRecord[];
  readonly count: number;
  /** Current value of held coins only (via sumCurrentValue, which excludes want-list coins). */
  readonly heldValue: number;
  /** Heading summary: coin count and held value. */
  readonly summary: string;
}

/** Lookups needed to format columns that store an id. */
export interface GroupingLookups {
  readonly catalogs?: readonly CatalogOption[];
  readonly denominations?: readonly PickerDenomination[];
}

/** The heading a coin belongs under, or null when it has no value for the column. */
export function groupKeyFor(
  coin: CoinRecord,
  column: InventoryColumn,
  lookups: GroupingLookups = {}
): string | null {
  // Group by the main reference alone; the grid's "(+N)" would split groups.
  if (column === 'catalogReference') {
    return mainCatalogRefLabel(lookups.catalogs, coin.catalogRefs) || null;
  }

  const formatted = formatInventoryCell(
    coin,
    column,
    undefined,
    lookups.catalogs,
    lookups.denominations
  ).trim();

  return !formatted || formatted === UNKNOWN_CELL ? null : formatted;
}

/** `12 coins · $1,234.56`. */
function describeGroup(count: number, heldValue: number): string {
  const coins = count === 1 ? '1 coin' : `${count} coins`;
  return `${coins} · $${heldValue.toFixed(2)}`;
}

/**
 * Orders groups alphabetically by heading, with the empty bucket always last.
 * Rows inside a group keep the user's sort. When the sort column is the
 * grouping column, sorting rows would do nothing, so the direction is applied
 * to the group order instead.
 */
function compareGroups(
  left: CoinGroup,
  right: CoinGroup,
  direction: 1 | -1
): number {
  if (left.isEmptyBucket !== right.isEmptyBucket) return left.isEmptyBucket ? 1 : -1;
  return compareText(left.label, right.label) * direction;
}

/** Direction of the group headings. See compareGroups. */
export function groupSortDirection(
  column: InventoryColumn,
  sort: SortState | null | undefined
): 1 | -1 {
  return sort && sort.column === column && sort.direction === 'desc' ? -1 : 1;
}

/**
 * Partition an already-filtered, already-sorted list into groups.
 * Input order is preserved within each group.
 */
export function buildCoinGroups(
  coins: readonly CoinRecord[],
  column: InventoryColumn,
  options: GroupingLookups & { readonly sort?: SortState | null } = {}
): CoinGroup[] {
  const emptyLabel = emptyGroupLabel(column);
  const buckets = new Map<string, CoinRecord[]>();

  for (const coin of coins) {
    const label = groupKeyFor(coin, column, options) ?? emptyLabel;
    const bucket = buckets.get(label);
    if (bucket) bucket.push(coin);
    else buckets.set(label, [coin]);
  }

  const groups: CoinGroup[] = [];
  for (const [label, bucketCoins] of buckets) {
    const heldValue = sumCurrentValue([...bucketCoins]);
    groups.push({
      label,
      isEmptyBucket: label === emptyLabel,
      coins: bucketCoins,
      count: bucketCoins.length,
      heldValue,
      summary: describeGroup(bucketCoins.length, heldValue)
    });
  }

  return groups.sort((left, right) =>
    compareGroups(left, right, groupSortDirection(column, options.sort))
  );
}

/* --- Rendered rows ---
 * One flat list of heading and coin rows, so the template is a single @for. */

/** A heading row or a coin row. `key` is the template's `track`. */
export type GridRow =
  | { readonly kind: 'group'; readonly key: string; readonly group: CoinGroup; readonly coin?: undefined }
  | { readonly kind: 'coin'; readonly key: string; readonly group?: undefined; readonly coin: CoinRecord };

/** Ungrouped grid: one coin row per coin, no headings. */
export function flatGridRows(coins: readonly CoinRecord[]): GridRow[] {
  return coins.map(coin => ({ kind: 'coin', key: `coin:${coin.id}`, coin }));
}

/** Headings, each followed by its coins when the group is open. */
export function groupedGridRows(
  groups: readonly CoinGroup[],
  expansion: GroupExpansion
): GridRow[] {
  const rows: GridRow[] = [];

  for (const group of groups) {
    rows.push({ kind: 'group', key: `group:${group.label}`, group });
    if (!isGroupExpanded(expansion, group.label)) continue;
    for (const coin of group.coins) {
      rows.push({ kind: 'coin', key: `coin:${coin.id}`, coin });
    }
  }

  return rows;
}

/**
 * The coins visible on screen, in order. Arrow-key navigation uses this, so
 * it skips collapsed groups. Headings are buttons reached by Tab, not arrows.
 */
export function renderedCoins(rows: readonly GridRow[]): CoinRecord[] {
  const coins: CoinRecord[] = [];
  for (const row of rows) if (row.kind === 'coin') coins.push(row.coin);
  return coins;
}

/* --- Persistence ---
 * Column, expansion and group orders are stored as one value because
 * expansion and order are meaningless without the column they apply to. */

/** Stored form of the grouping. `exceptions` is an array because a Set doesn't serialise cleanly. */
export interface StoredGroupingState {
  readonly column: string | null;
  readonly collapsedByDefault: boolean;
  readonly exceptions: readonly string[];
  /**
   * The user's dragged group order per column. Owned by group-order.ts
   * (serializeGroupOrders / restoreGroupOrders); this file doesn't inspect it.
   */
  readonly orders: Readonly<Record<string, readonly string[]>>;
}

/** No grouping, everything collapsed. Fallback for missing or unreadable state. */
export const DEFAULT_GROUPING: { column: InventoryColumn | null; expansion: GroupExpansion } = {
  column: null,
  expansion: { collapsedByDefault: true, exceptions: new Set<string>() }
};

/**
 * `orders` arrives pre-serialised from group-order.ts. This file must not
 * import group-order.ts, which already imports from here (would be a cycle).
 */
export function serializeGrouping(
  column: InventoryColumn | null,
  expansion: GroupExpansion,
  orders: Readonly<Record<string, readonly string[]>> = {}
): StoredGroupingState {
  return {
    column,
    collapsedByDefault: expansion.collapsedByDefault,
    exceptions: [...expansion.exceptions],
    orders
  };
}

/**
 * Read a saved grouping back. Never throws: anything invalid, including a
 * column that no longer exists or isn't groupable, falls back to no grouping.
 * Saved `orders` are restored separately by restoreGroupOrders in group-order.ts.
 */
export function restoreGrouping(stored: unknown): {
  column: InventoryColumn | null;
  expansion: GroupExpansion;
} {
  if (!stored || typeof stored !== 'object') return DEFAULT_GROUPING;

  const value = stored as Partial<StoredGroupingState>;
  if (!isGroupableColumn(typeof value.column === 'string' ? value.column : null)) {
    return DEFAULT_GROUPING;
  }

  const exceptions = Array.isArray(value.exceptions)
    ? value.exceptions.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    column: value.column as InventoryColumn,
    // Anything other than an explicit `false` means collapsed.
    expansion: {
      collapsedByDefault: value.collapsedByDefault !== false,
      exceptions: new Set(exceptions)
    }
  };
}
