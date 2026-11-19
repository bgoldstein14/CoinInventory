 /*
  * Describes how worksheets' headings differ, in sentences the user can act on:
  *   Sheet 'Gold' has a column 'AGW' that 'Silver' does not.
  *
  * - Matching is normalised (`Cost`, `cost `, `COST` are one column); messages
  *   quote the heading as that sheet spells it.
  * - Column order is not a difference (the mapping is keyed by header text).
  * - Sheets with no headings are ignored.
  */

import { normalizeHeader } from '../csv/header-synonyms';

/** What a sheet needs to take part in the comparison. */
export interface ComparableSheet {
  name: string;
  headers: string[];
}

/** One sheet's headings that no other sheet has. */
export interface SheetHeaderDifference {
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
  /** The raw differences. */
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
 * Compares the heading sets of several worksheets. Sheets without headings are
 * ignored; fewer than two remaining means consistent.
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

  // Normalised key -> heading as this sheet spells it (last spelling wins).
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
