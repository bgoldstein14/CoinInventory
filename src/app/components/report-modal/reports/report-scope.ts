/*
 * report-scope.ts — the line that says what the printed page actually covers.
 *
 * The inventory listing prints `filters.filteredInventory()`, which is the
 * least surprising thing "Print" can do. But a listing of twelve coins
 * produced while a category filter was on looks EXACTLY like a listing of a
 * twelve-coin collection, there is nothing on the paper to tell them apart,
 * and paper outlives the filter box. So the document carries one sentence
 * naming every filter that was active, the counts on both sides of it, and
 * the sort order.
 *
 * WHY IT TAKES PLAIN VALUES AND NOT THE STORE. `InventoryFilterStore` is a
 * bundle of signals, and a function that reads one is only testable inside
 * an Angular injection context. Taking the already-read values keeps this a
 * pure function of its arguments, so the wording — the part that is easy to
 * get wrong — can be checked under Node with no DOM. The component does the
 * one line of unwrapping.
 */

import { SortState } from '../../../types/inventory-columns';
import { ReportField } from './report-types';
import { reportFieldLabel } from './report-fields';

/**
 * The sentinel `InventoryFilterStore` uses for "do not filter by this".
 *
 * Duplicated as a local constant rather than imported from the store, so
 * this module stays a leaf that imports no feature code — an import cycle
 * here throws a temporal-dead-zone error at application start. The value is
 * pinned by a test that feeds 'All' in and expects no filter reported.
 */
const NO_FILTER_SENTINEL = 'All';

export interface ReportScopeInput {
  searchQuery: string;
  /** 'All' means unfiltered. */
  category: string;
  /** 'All' means unfiltered. */
  coinSet: string;
  grade: string;
  valueMin: string;
  valueMax: string;
  source: string;
  country: string;
  sort: SortState;
  /** How many coins the report is printing. */
  shown: number;
  /** How many coins exist in total. */
  total: number;
}

/** A filter box counts as active only if it holds something other than space. */
function active(value: string, sentinel?: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (sentinel && text === sentinel) return null;
  return text;
}

/**
 * One sentence (or three) describing the slice of the collection on the page.
 *
 * Always returns text — there is no case where saying nothing is better.
 * An unfiltered report says "All 412 coins", which is itself a useful claim
 * to have in writing.
 */
export function describeReportScope(input: ReportScopeInput): string {
  const parts: string[] = [];

  // Ordered the way the filter bar reads, top to bottom, so somebody holding
  // the paper can walk the screen and reproduce it.
  const filters: [string, string | null][] = [
    ['Search', active(input.searchQuery)],
    ['Category', active(input.category, NO_FILTER_SENTINEL)],
    ['Set', active(input.coinSet, NO_FILTER_SENTINEL)],
    ['Grade starts with', active(input.grade)],
    ['Value from', active(input.valueMin)],
    ['Value to', active(input.valueMax)],
    ['Country', active(input.country)],
    ['Source', active(input.source)]
  ];

  const applied = filters
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => `${label}: ${value}`);

  if (applied.length === 0) {
    // No filter at all, so the two counts are the same number and printing
    // "412 of 412" would only invite the reader to look for the difference.
    parts.push(`All ${input.total} coins.`);
  } else {
    parts.push(`${applied.join(' · ')}.`);
    parts.push(`Showing ${input.shown} of ${input.total} coins.`);
  }

  // The sort order is stated even when nothing is filtered: a printed table
  // in an order nobody can account for is hard to check against anything.
  // reportFieldLabel() rather than the grid header, because the grid says
  // 'MM' and 'Denom.' to save width and this is read by somebody who may
  // never have seen the grid.
  const direction = input.sort.direction === 'asc' ? 'ascending' : 'descending';
  parts.push(`Sorted by ${reportFieldLabel(input.sort.column as ReportField)}, ${direction}.`);

  return parts.join(' ');
}
