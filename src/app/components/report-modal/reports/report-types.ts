/*
 * report-types.ts — the shape of a printable report, and nothing else.
 *
 * WHY A "DOCUMENT" OBJECT SITS BETWEEN THE DATA AND THE PAGE. The frontend
 * test suite runs under Node with NO jsdom, so there is no way to render
 * something and then assert on what came out. Built straight into markup, the
 * only testable thing about a report would be the markup string, and every
 * interesting question — which coins are on the page, what the total is, what
 * was left out and why — would have to be answered by pattern-matching HTML.
 * So the pipeline has a seam in the middle:
 *
 *     coins + options  --(build-report.ts, PURE)-->  ReportDocument
 *     ReportDocument   --(report-html.ts,  PURE)-->  one HTML string
 *     HTML string      --(print-window.ts, DOM  )-->  a print dialog
 *
 * Everything decided in the first step is a plain object, so the CONTENT of a
 * report is unit-testable with no browser at all. Only the last step touches
 * the DOM, and it is four lines long.
 *
 * WHY THE DOCUMENT CARRIES PRE-FORMATTED STRINGS. `cells` are strings, not
 * numbers, and the totals carry `amountText` beside the raw figure, so that
 * the formatting decisions — the ones that go wrong, like a melt value of
 * `null` rendered as "$0.00" — are made in a tested pure function rather than
 * in an untestable template. The renderer only escapes and lays out text
 * somebody else already decided on.
 */

import { InventoryColumn } from '../../../types/inventory-columns';

/**
 * Which report this is.
 *
 * 'insurance' — a dated schedule of what is owned and what it is worth, with
 *               photographs, aimed at somebody outside the household.
 * 'inventory' — the collection as the owner currently has it filtered and
 *               sorted on screen, in a readable printed form.
 */
export type ReportKind = 'insurance' | 'inventory';

/**
 * A field a report can print.
 *
 * Mostly these ARE inventory grid columns, and that is the point — the grid's
 * `formatInventoryCell` already knows how to render every one of them, so a
 * column added to the grid becomes printable with no change here at all. The
 * handful of extras are fields the grid has no column for but a printed
 * document genuinely wants (see report-fields.ts).
 */
export type ReportField =
  | InventoryColumn
  | 'purchaseDate'
  | 'composition'
  // `certCompany` is one of those extras. The grid has no column for it
  // because its `certNumber` cell already leads with the company ("NGC
  // #2599001"). A printed schedule is different: it is read by an insurer or
  // an adjuster who cares that a coin is third-party graded, and the company
  // belongs in its own labelled column rather than buried in a badge.
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
  /**
   * Already-downscaled `data:` URLs. NEVER the stored ~1600px originals —
   * see report-images.ts for why a few hundred of those cannot go on a page.
   */
  images: string[];
}

/**
 * A sum, plus an honest account of what is NOT in it. This type is the whole
 * point of the totals code.
 *
 * `computeMeltValue` returns null rather than 0 when it cannot know a figure,
 * on the governing rule stated at the top of services/pm-reference.ts: a
 * visible blank beats a silently wrong number. A total has the same problem
 * one level up. If four coins have no recorded value, adding them as zero
 * produces a confident-looking grand total that UNDERSTATES AN INSURANCE
 * CLAIM by whatever those four coins are worth — and nothing on the page says
 * so.
 *
 * Splitting the answer into three numbers makes the omission impossible to
 * hide: the renderer prints `counted` beside the money and `unknown` as a
 * caveat underneath it.
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

/** A whole coin left off the report, and the reason a reader deserves. */
export interface ReportExclusion {
  reason: string;
  count: number;
}

export interface ReportDocument {
  kind: ReportKind;
  title: string;
  /**
   * One sentence saying what this document is for, printed under the title.
   *
   * A reader has to be able to tell what the report contains without asking
   * anybody, and that has to survive leaving the app: the printed page is
   * read by an insurer or a loss adjuster who has never seen the software.
   */
  purpose: string;
  /** Already formatted for a reader, e.g. "November 8, 2026". */
  generatedAt: string;
  /**
   * "Category: Silver · Search: morgan" — what the user had filtered to.
   * Null when the report covers everything. Printing this stops a filtered
   * page being mistaken for the whole collection.
   */
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
