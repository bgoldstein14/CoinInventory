/*
 * report-scope.ts — the line stating which filters, counts and sort order a
 * printed inventory listing covers, so a filtered printout is not mistaken
 * for the whole collection. Takes plain values (not the filter store) so it
 * is testable without an injection context.
 */

import { SortState } from '../../../types/inventory-columns';
import { ReportField } from './report-types';
import { reportFieldLabel } from './report-fields';

/**
 * InventoryFilterStore's "do not filter by this" sentinel. Duplicated rather
 * than imported to avoid an import cycle with feature code.
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
 * Describe the slice of the collection on the page. Always returns text; an
 * unfiltered report says "All 412 coins".
 */
export function describeReportScope(input: ReportScopeInput): string {
  const parts: string[] = [];

  // Same order as the filter bar.
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
    parts.push(`All ${input.total} coins.`);
  } else {
    parts.push(`${applied.join(' · ')}.`);
    parts.push(`Showing ${input.shown} of ${input.total} coins.`);
  }

  // Always state the sort, using the full report label rather than the grid's abbreviation.
  const direction = input.sort.direction === 'asc' ? 'ascending' : 'descending';
  parts.push(`Sorted by ${reportFieldLabel(input.sort.column as ReportField)}, ${direction}.`);

  return parts.join(' ');
}
