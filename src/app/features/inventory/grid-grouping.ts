/*
 * grid-grouping.ts — the rules for folding the main grid into groups.
 *
 * THE PROBLEM THIS SOLVES. A dealer's collection is 457 coins and climbing.
 * Scrolling it is the only way to answer "how much Mexico have I got?", and
 * the answer takes a minute of scrolling and a memory for where the Mexican
 * rows started. Grouped by Country the same question is one line of a list
 * of sixty headings, with the count and the money on the heading, and no
 * group needs opening to read it.
 *
 * NOTHING SELECTED IS NOT A GROUPING. With no column chosen this module
 * hands back one row per coin, in the order the filter store already sorted
 * them, with no headings at all — the identical flat grid, not a grid with
 * a single group wrapped round it. That is the default and it is the state
 * the overwhelming majority of sessions stay in, so it is a plain map over
 * the array and costs nothing.
 *
 * WHICH COLUMNS MAY BE GROUPED BY. Not the numeric ones, and not a boolean
 * if this grid ever grows one. Grouping by Value gives one group per
 * distinct price — 457 groups of one coin, which is the flat grid with a
 * heading wasted on every row — and grouping by a yes/no gives two buckets
 * that a filter answers better. The qualifying set is declared below as an
 * EXHAUSTIVE Record over InventoryColumn, so a column added to
 * inventoryColumnOrder without a kind fails the build rather than silently
 * becoming groupable.
 *
 * WHY A DEFAULT PLUS EXCEPTIONS, AND NOT A SET OF COLLAPSED HEADINGS. The
 * same trap category-modal/denomination-expansion.ts documents, and it bites
 * harder here because this list is filtered constantly. "The set of groups
 * the user folded" has to be enumerated from the groups on screen at the
 * time, so:
 *
 *   * Collapse all with a search running (six countries visible), clear the
 *     search, and the other fifty-four spring open — they were never in the
 *     set, because they were not on screen to be put there.
 *   * Collapse all, then import a coin from a country not previously held,
 *     and its brand-new group renders open among sixty closed ones.
 *
 * Storing a DEFAULT and the headings that differ from it has neither hole: a
 * group nobody has ever seen follows the default, which is what "all" means.
 *
 * THE SHAPE IS DELIBERATELY A COPY OF GroupExpansion IN THE CATEGORY MODAL,
 * NOT AN IMPORT. Reaching from the grid into a modal's folder to borrow a
 * type would couple two unrelated screens, and the two are not the same type
 * for long: this one is persisted (the category modal's explicitly is not),
 * so it needs a serialised form and a validator that the other must never
 * grow. The IDEA is reused; the file is not.
 *
 * Pure, dependency-free of Angular and DOM-free: the frontend suite runs
 * under Node with no jsdom, so a rule decided inside a template cannot be
 * tested at all.
 */
import { CoinRecord } from '../../types/coin.model';
import { CatalogOption } from '../../types/catalog-reference';
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
 * What kind of value a column holds, for the one question this module asks
 * of it: may the user group by it?
 *
 * EXHAUSTIVE OVER InventoryColumn ON PURPOSE. `Record<InventoryColumn, ...>`
 * means a new column with no entry here is a compile error, so the next
 * money column cannot arrive in the Group by menu by default. There is no
 * boolean column today — `hasCacSticker` is rendered inside the Grade cell
 * and is not in inventoryColumnOrder — but the kind exists so that the first
 * one can be marked and excluded without a second mechanism.
 */
export type GroupingColumnKind = 'text' | 'numeric' | 'boolean';

export const GROUPING_COLUMN_KINDS: Record<InventoryColumn, GroupingColumnKind> = {
  // Year is TEXT in the database so that "1916-1945" and "1878-S" survive,
  // and it groups beautifully — a date-ordered list of years with a count
  // against each is exactly the shape of a collection.
  year: 'text',
  mintMark: 'text',
  denomination: 'text',
  coinType: 'text',
  certNumber: 'text',
  grade: 'text',
  collectionStatus: 'text',
  category: 'text',
  country: 'text',
  // --- The money and the measurements. None of these may be grouped by. ---
  purchasePrice: 'numeric',
  currentValue: 'numeric',
  meltValue: 'numeric',
  soldPrice: 'numeric',
  // -----------------------------------------------------------------------
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
 * May the grid be grouped by this column?
 *
 * Takes a `string` rather than an `InventoryColumn` because its other caller
 * is the restore path, which is handed whatever a previous build wrote into
 * IndexedDB — including the name of a column that has since been deleted.
 */
export function isGroupableColumn(column: string | null | undefined): column is InventoryColumn {
  if (!column) return false;
  const kind = (GROUPING_COLUMN_KINDS as Record<string, GroupingColumnKind | undefined>)[column];
  return kind === 'text';
}

/**
 * How a column is named in the Group by menu and in its empty bucket.
 *
 * Mostly the grid headers, which is what the user is looking at — but the
 * headers are abbreviated to save width in a dense grid, and "(No Denom.)"
 * as a group heading reads like a typo. The two columns whose headers are
 * contractions are spelled out here and nowhere else.
 */
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

/**
 * The Group by menu, in canonical column order.
 *
 * EVERY groupable column, not only the visible ones. Grouping by Country
 * with the Country column switched off is a perfectly sensible thing to
 * want — the value is on the group heading, so the column would only repeat
 * it on every row — and a menu whose contents changed as the user ticked
 * boxes in the Columns panel would be the more surprising of the two.
 */
export const GROUPING_OPTIONS: readonly GroupingOption[] = inventoryColumnOrder
  .filter(isGroupableColumn)
  .map(column => ({ column, label: GROUPING_COLUMN_LABELS[column] }));

/**
 * Which groups are open.
 *
 * `exceptions` holds the headings that do NOT follow `collapsedByDefault` —
 * a set of OPEN groups while the default is collapsed, and a set of CLOSED
 * groups once the user has pressed Expand all. Keyed by the heading text,
 * which is what the grid renders and what the user clicked.
 */
export interface GroupExpansion {
  readonly collapsedByDefault: boolean;
  readonly exceptions: ReadonlySet<string>;
}

/**
 * WHAT A FRESHLY CHOSEN GROUPING LOOKS LIKE: everything shut.
 *
 * Choosing a grouping is asking "what shape is this collection?", and sixty
 * headings answer that in one screen. Opening them all would hand back the
 * same 457-row scroll the user was trying to escape, plus sixty extra rows
 * of heading — strictly worse than the flat grid. So every grouping starts
 * here, and the one control next to the menu opens them.
 */
export function collapseAllGroups(): GroupExpansion {
  return { collapsedByDefault: true, exceptions: new Set<string>() };
}

/** Every group open — including the ones not currently on screen. */
export function expandAllGroups(): GroupExpansion {
  return { collapsedByDefault: false, exceptions: new Set<string>() };
}

/** Is this group open? */
export function isGroupExpanded(state: GroupExpansion, heading: string): boolean {
  return state.exceptions.has(heading) ? state.collapsedByDefault : !state.collapsedByDefault;
}

/** Open it if it is shut, shut it if it is open. */
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

/** What the one control does next, and what it should say while it waits. */
export interface ExpandAllControl {
  /** What pressing it does — the caller passes this straight back in. */
  readonly action: 'expand' | 'collapse';
  readonly label: string;
  /** The longer form, for `aria-label` and the tooltip. */
  readonly ariaLabel: string;
}

/**
 * ONE CONTROL, NOT TWO.
 *
 * Two buttons mean one of them is always a no-op and the user cannot see
 * which: "Collapse all" with everything already shut looks broken rather
 * than redundant. The control reads the current state and offers the half
 * that would change something.
 *
 * ANYTHING OPEN MEANS COLLAPSE — not "most of them", not a majority count.
 * The reason to press this is to get the list of headings back, and one
 * group left open is enough to bury the headings below it.
 */
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

/** Apply the control. The whole of what the button's click handler does. */
export function applyExpandAllControl(action: 'expand' | 'collapse'): GroupExpansion {
  return action === 'collapse' ? collapseAllGroups() : expandAllGroups();
}

/**
 * The em-dash every unknown cell in this grid renders. A coin whose grouping
 * column formats to this has no value for it, and goes in the empty bucket.
 *
 * Reading the FORMATTED cell rather than the raw field is what keeps the
 * group heading and the column underneath it saying the same words — the
 * denomination cell resolves an id through a lookup, the catalogue cell
 * joins two fields, and a second hand-rolled copy of either rule is how a
 * heading ends up disagreeing with every row beneath it.
 */
const UNKNOWN_CELL = '—';

/**
 * What the bucket of rows with no value is called.
 *
 * PARENTHESISED AND PREFIXED "No", so it cannot be mistaken for a real one.
 * A country column genuinely containing the word "Unknown" or "Other" is
 * ordinary in an imported collection; a country called "(No Country)" is
 * not. The bucket is also flagged `isEmptyBucket` so the template can mute
 * it, and it is pinned to the bottom of the list — see compareGroups.
 */
export function emptyGroupLabel(column: InventoryColumn): string {
  return `(No ${GROUPING_COLUMN_LABELS[column]})`;
}

/** One group of coins, ready to render as a heading plus its rows. */
export interface CoinGroup {
  /** The heading text, and the key the expansion state is stored against. */
  readonly label: string;
  /** True for the "no value recorded" bucket. */
  readonly isEmptyBucket: boolean;
  readonly coins: readonly CoinRecord[];
  /** How many coins, i.e. `coins.length`, named so a template can read it. */
  readonly count: number;
  /**
   * What the coins in this group that the owner actually HAS are worth.
   *
   * Through `sumCurrentValue`, which filters to held coins, and not a local
   * reduce: a want list summed into a valuation reports a collection several
   * times larger than the one in the safe and looks entirely plausible doing
   * it. That rule lives in one place (see inventory-metrics.ts) and this is
   * a fourth caller, not a second copy.
   */
  readonly heldValue: number;
  /**
   * The line the dealer reads without opening anything: how many coins, and
   * what the held ones are worth.
   */
  readonly summary: string;
}

/** The lookups the grouping key needs, for the columns that store an id. */
export interface GroupingLookups {
  readonly catalogs?: readonly CatalogOption[];
  readonly denominations?: readonly PickerDenomination[];
}

/**
 * The heading a single coin belongs under, or null when it has no value for
 * the grouping column.
 */
export function groupKeyFor(
  coin: CoinRecord,
  column: InventoryColumn,
  lookups: GroupingLookups = {}
): string | null {
  const formatted = formatInventoryCell(
    coin,
    column,
    undefined,
    lookups.catalogs,
    lookups.denominations
  ).trim();

  return !formatted || formatted === UNKNOWN_CELL ? null : formatted;
}

/** `12 coins · $1,234.56`, with the singular handled. */
function describeGroup(count: number, heldValue: number): string {
  const coins = count === 1 ? '1 coin' : `${count} coins`;
  return `${coins} · $${heldValue.toFixed(2)}`;
}

/**
 * HOW THE GROUPS THEMSELVES ARE ORDERED — and it is not the same question as
 * how the rows inside them are.
 *
 * Rows inside a group keep the sort the user chose from the column headers,
 * untouched: `buildCoinGroups` partitions an already-sorted list and never
 * re-sorts it, so a grid sorted by Year stays sorted by Year inside every
 * country. That is the behaviour that does not need explaining.
 *
 * The groups are ordered by their heading, ascending — France, Germany,
 * Mexico — because the reason to group by Country is to find a country, and
 * an alphabetical list of headings is how anybody looks one up.
 *
 * WITH ONE EXCEPTION, AND IT IS A BUG FIX, NOT A FLOURISH. When the sort
 * column IS the grouping column, every row in a group holds the same value,
 * so sorting the rows by it does precisely nothing: clicking the Country
 * header while grouped by Country would appear to be a dead control. In
 * that one case the direction is applied to the GROUP order instead, so the
 * header still reverses something the user can see.
 *
 * THE EMPTY BUCKET IS PINNED LAST IN BOTH DIRECTIONS. "No value recorded" is
 * not a value, so it has no place in the alphabet; and on an imported
 * collection it is routinely the biggest group there is, which at the top of
 * the list would bury every real heading below a screenful of unattributed
 * coins.
 */
function compareGroups(
  left: CoinGroup,
  right: CoinGroup,
  direction: 1 | -1
): number {
  if (left.isEmptyBucket !== right.isEmptyBucket) return left.isEmptyBucket ? 1 : -1;
  return compareText(left.label, right.label) * direction;
}

/** Which way the group headings run. See compareGroups. */
export function groupSortDirection(
  column: InventoryColumn,
  sort: SortState | null | undefined
): 1 | -1 {
  return sort && sort.column === column && sort.direction === 'desc' ? -1 : 1;
}

/**
 * Fold an already-filtered, already-sorted list of coins into groups.
 *
 * The input order is preserved inside every group — this partitions, it does
 * not sort. See compareGroups for what decides the order of the groups.
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

/* =======================================================================
 * WHAT THE TABLE ACTUALLY RENDERS
 *
 * One flat list of rows, each either a heading or a coin, so the template
 * stays a single @for and the hundred lines of coin-row markup are written
 * once. A grouped grid and a flat grid differ only in what is in this list.
 * ======================================================================= */

/** A heading row, or a coin row. `key` is the template's `track`. */
export type GridRow =
  | { readonly kind: 'group'; readonly key: string; readonly group: CoinGroup; readonly coin?: undefined }
  | { readonly kind: 'coin'; readonly key: string; readonly group?: undefined; readonly coin: CoinRecord };

/**
 * NOTHING SELECTED IS EXACTLY TODAY'S GRID — one coin row per coin, in the
 * order they arrived, and not a single heading. This is the function that
 * guarantees it, and it is deliberately the trivial branch.
 */
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
 * The coins the user can actually see, in screen order.
 *
 * WHAT THE ARROW KEYS DO AT A COLLAPSED GROUP BOUNDARY, and it falls out of
 * this function rather than being a rule of its own: Down from the last row
 * of an open group lands on the first row of the next OPEN group, skipping
 * every collapsed group in between. A collapsed group has no rows on screen,
 * and moving focus onto an element that is not rendered would park the tab
 * stop somewhere invisible with no way back.
 *
 * Headings are NOT in the arrow-key sequence. They are real <button>s, so
 * Tab reaches them and Enter or Space opens the group — and grid-keyboard.ts
 * already returns "not ours" for a key pressed on a BUTTON, so the row
 * handler never sees it. Arrows move between COINS; Tab moves between the
 * controls that reveal them.
 */
export function renderedCoins(rows: readonly GridRow[]): CoinRecord[] {
  const coins: CoinRecord[] = [];
  for (const row of rows) if (row.kind === 'coin') coins.push(row.coin);
  return coins;
}

/* =======================================================================
 * REMEMBERING IT ACROSS SESSIONS
 *
 * The grouping and its expansion are persisted as ONE value, because
 * expansion is meaningless without the column it folds: a set of open
 * headings restored against a different grouping names groups that do not
 * exist. They are written together and validated together.
 * ======================================================================= */

/** The grouping as it is written to storage. `exceptions` is an array — a Set does not survive structured clone cleanly across builds. */
export interface StoredGroupingState {
  readonly column: string | null;
  readonly collapsedByDefault: boolean;
  readonly exceptions: readonly string[];
  /**
   * The user's dragged order for each column he has arranged — see
   * features/inventory/group-order.ts, which owns this sub-document end to
   * end (it is built by `serializeGroupOrders` and read back by
   * `restoreGroupOrders`; nothing in this file inspects it).
   *
   * IN THIS KEY RATHER THAN A SECOND ONE, for the reason at the top of the
   * section: an order of headings is meaningless without the column it folds,
   * exactly like the expansion state beside it, so the three are written
   * together and validated together.
   *
   * KEYED BY COLUMN, NOT A SINGLE LIST. An order of countries cannot be
   * applied while the grid is grouped by Grade, and throwing it away because
   * the user glanced at Grade would destroy a minute of dragging. Both orders
   * are kept and only the current column's is ever used.
   */
  readonly orders: Readonly<Record<string, readonly string[]>>;
}

/** No grouping, everything shut. What a fresh install starts as, and what
 *  anything unreadable degrades to. */
export const DEFAULT_GROUPING: { column: InventoryColumn | null; expansion: GroupExpansion } = {
  column: null,
  expansion: { collapsedByDefault: true, exceptions: new Set<string>() }
};

/**
 * `orders` is passed in already serialised, by `serializeGroupOrders` in
 * group-order.ts, rather than being built here: the ordering rules are that
 * module's and this file deliberately does not import it, so that the
 * dependency runs one way (group-order.ts reads `isGroupableColumn` from
 * here) and cannot become a cycle.
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
 * Read a saved grouping back, DEGRADING RATHER THAN THROWING.
 *
 * The value is JSON from a browser database that an older build wrote, and
 * columns in this project genuinely come and go — `Source` was dropped from
 * the grid yesterday. A saved `{ column: 'source' }` must not group by a
 * column that no longer exists, must not throw on the way past, and must
 * not leave the user looking at an empty or nonsensical grid he has no way
 * to explain. Every failure lands on the same answer: no grouping, which is
 * the flat grid he has been using for years.
 *
 * `isGroupableColumn` is the gate rather than a plain membership test, so a
 * column that still exists but has become numeric (or was never groupable
 * and got in there by hand) is refused too.
 *
 * THE SAVED `orders` ARE NOT READ HERE. They are read out of the same blob by
 * `restoreGroupOrders` in group-order.ts, which validates them per column —
 * and which keeps them even when the saved COLUMN is unusable, because an
 * order for Country is still good after a saved grouping by the deleted
 * `source` column has been thrown away.
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
    // Anything that is not an explicit `false` means collapsed. The folded
    // state is the safe one: it shows the shape of the collection and every
    // coin is one click away, where a wrongly-expanded 457-row grid is the
    // scroll this feature exists to remove.
    expansion: {
      collapsedByDefault: value.collapsedByDefault !== false,
      exceptions: new Set(exceptions)
    }
  };
}
