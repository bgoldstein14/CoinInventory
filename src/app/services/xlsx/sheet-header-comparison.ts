 /*
 * sheet-header-comparison.ts — naming what differs between worksheets.
 * ---- WHY THIS FILE EXISTS ----
 * A dealer's workbook has a tab per metal, or per year, or per storage box.
 * They are usually the same shape and occasionally not: the Gold tab grew an
 * `AGW` column in 2015 and nothing else did. Importing all of them together
 * is still the right thing to do -- the user just has to know what differs
 * before they commit, because the odd column out is where their data gets
 * dropped if they are not paying attention.
 *
 * ---- THE WHOLE POINT IS THE WORDING ----
 * "Columns are inconsistent across sheets" is a warning that cannot be acted
 * on. It does not say which sheet, which column, or whether it matters, so
 * the only thing the user can do with it is go back to Excel and compare
 * thirty headings by eye -- or, far more likely, ignore it.
 *
 *   Sheet 'Gold' has a column 'AGW' that 'Silver' does not.
 *
 * can be acted on without leaving the dialog. That sentence is what this
 * module is for; the set arithmetic is incidental.
 *
 * ---- WHAT COUNTS AS A DIFFERENCE, AND WHAT DOES NOT ----
 * MATCHING IS NORMALISED, REPORTING IS VERBATIM. `Cost`, `cost ` and `COST`
 * are one column; reporting them as three would bury the real `AGW` in
 * noise. But the message quotes the heading exactly as the user typed it,
 * because that is the string they will search their workbook for.
 *
 * ORDER IS NOT A DIFFERENCE. The mapping is keyed by header text and applied
 * against each sheet's own header array, so a tab with its columns in a
 * different order imports perfectly. Flagging that would be a false alarm,
 * and false alarms are how real warnings get ignored.
 *
 * A SHEET WITH NO HEADINGS IS NOT A DIFFERENCE, it is an absence. Counting
 * the leftover empty Sheet3 would make almost every workbook look
 * inconsistent.
  */

import { normalizeHeader } from '../csv/header-synonyms';

/** The minimum a sheet has to offer to take part in the comparison. */
export interface ComparableSheet {
  name: string;
  headers: string[];
}

/** One sheet's headings that no other sheet has. */
export interface SheetHeaderDifference {
  /** The sheet that has the extra columns. */
  sheet: string;
  /** Those columns, spelled as that sheet spells them. */
  extra: string[];
  /** The sheets that lack them. */
  absentFrom: string[];
}

export interface SheetHeaderComparison {
  /** True when every compared sheet has the same set of headings. */
  consistent: boolean;
  /** Headings present on every compared sheet, in first-sheet order. */
  common: string[];
  /** The raw differences, for anything that wants more than the sentences. */
  differences: SheetHeaderDifference[];
  /** Ready-to-show sentences, one per sheet that has extra columns. */
  messages: string[];
}

/** `['a']` -> `'a'`; `['a','b']` -> `'a' and 'b'`; `['a','b','c']` -> `'a', 'b' and 'c'`. */
function quoteList(items: string[]): string {
  const quoted = items.map(item => `'${item}'`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * Compare the heading sets of several worksheets.
 *
 * Sheets with no headings are ignored entirely; fewer than two sheets left
 * after that means there is nothing to compare and the result is consistent
 * by definition.
 */
export function compareSheetHeaders(sheets: ComparableSheet[]): SheetHeaderComparison {
  const comparable = sheets.filter(sheet => sheet.headers.length > 0);

  if (comparable.length < 2) {
    return {
      consistent: true,
      common: comparable[0]?.headers ?? [],
      differences: [],
      messages: []
    };
  }

  // Normalised key -> the heading as this sheet spells it. Last spelling on a
  // sheet wins, which only matters if one sheet has two headings that
  // normalise the same, and in that case either is as good as the other.
  const spellings = comparable.map(sheet => {
    const byKey = new Map<string, string>();
    for (const header of sheet.headers) {
      const key = normalizeHeader(header);
      if (key) byKey.set(key, header);
    }
    return { name: sheet.name, byKey };
  });

  const common = [...spellings[0].byKey.entries()]
    .filter(([key]) => spellings.every(sheet => sheet.byKey.has(key)))
    .map(([, header]) => header);

  const differences: SheetHeaderDifference[] = [];
  for (const sheet of spellings) {
    const others = spellings.filter(other => other !== sheet);
    const extra: string[] = [];
    const absentFrom = new Set<string>();

    for (const [key, header] of sheet.byKey) {
      const lacking = others.filter(other => !other.byKey.has(key));
      if (lacking.length === 0) continue;
      extra.push(header);
      for (const other of lacking) absentFrom.add(other.name);
    }

    if (extra.length > 0) {
      differences.push({ sheet: sheet.name, extra, absentFrom: [...absentFrom] });
    }
  }

  const messages = differences.map(difference => {
    const noun = difference.extra.length === 1 ? 'a column' : 'columns';
    const verb = difference.absentFrom.length === 1 ? 'does' : 'do';
    return `Sheet '${difference.sheet}' has ${noun} ${quoteList(difference.extra)} ` +
      `that ${quoteList(difference.absentFrom)} ${verb} not.`;
  });

  return {
    consistent: differences.length === 0,
    common,
    differences,
    messages
  };
}
