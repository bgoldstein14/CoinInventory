/*
 * report-types.ts — the shape of a printable report.
 *
 *     coins + options  --(build-report.ts, pure)-->  ReportDocument
 *     ReportDocument   --(report-html.ts,  pure)-->  one HTML string
 *     HTML string      --(print-window.ts, DOM )-->  a print dialog
 *
 * Cells and totals carry pre-formatted strings so all formatting is decided
 * in tested pure code; the renderer only escapes and lays out text.
 */

import { InventoryColumn } from '../../../types/inventory-columns';

/**
 * Which report this is: 'insurance' (dated schedule of held coins with
 * photographs) or 'inventory' (the grid as currently filtered and sorted).
 */
export type ReportKind = 'insurance' | 'inventory';

/**
 * A field a report can print: any inventory grid column, plus a few fields
 * the grid has no column for (see report-fields.ts).
 */
export type ReportField =
  | InventoryColumn
  | 'purchaseDate'
  | 'composition'
  // The grid shows the company inside the certNumber cell; reports give it its own column.
  | 'certCompany';

export interface ReportColumn {
  key: ReportField;
  /** The full-word heading. Not necessarily the grid's abbreviated one. */
  label: string;
  /** Right-align, so decimal points line up down a printed column. */
  numeric: boolean;
}

export interface ReportRow {
  coinId: string;
  /** One formatted string per column, in the same order as `columns`. */
  cells: string[];
  /** Downscaled thumbnail `data:` URLs, never the stored originals. */
  images: string[];
}

/**
 * A sum plus a count of what is not in it, so the page can state how many
 * coins had no known value instead of silently treating them as zero.
 */
export interface HonestTotal {
  /** The sum of the values that are actually known. */
  total: number;
  /** How many coins contributed to `total`. */
  counted: number;
  /** How many coins had no knowable value and so are NOT in `total`. */
  unknown: number;
}

export interface ReportTotal {
  label: string;
  amount: HonestTotal;
  /** `total` as currency — or an em-dash when nothing at all is known. */
  amountText: string;
  /** "17 coins" — what the figure is based on. */
  basis: string;
  /** The "N coins are NOT included" sentence, or null when none are missing. */
  caveat: string | null;
}

/** Coins left off the report, grouped by reason. */
export interface ReportExclusion {
  reason: string;
  count: number;
}

export interface ReportDocument {
  kind: ReportKind;
  title: string;
  /** One sentence saying what this document is for, printed under the title. */
  purpose: string;
  /** Already formatted for a reader, e.g. "November 8, 2026". */
  generatedAt: string;
  /** "Category: Silver · Search: morgan" — the active filters, or null for everything. */
  scopeNote: string | null;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportTotal[];
  exclusions: ReportExclusion[];
  /** Plain-English account of the photographs, or null when there are none. */
  imageNote: string | null;
  /** Does any row have a photograph? Drives the photo column's existence. */
  hasImages: boolean;
}
