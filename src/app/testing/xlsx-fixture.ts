/*
 * Building a real `.xlsx` file inside a test.
 *
 * WHY THIS EXISTS RATHER THAN A COMMITTED BINARY
 * The `.xlsx` importer has to survive the things real spreadsheets do: serial
 * dates, currency number formats, formulas with a cached result, blank rows,
 * trailing blank columns, merged header cells, several worksheets whose
 * columns do not agree. Proving that needs files that contain those things.
 *
 * A checked-in `.xlsx` would be a zip of XML nobody can read in a diff. When
 * one of these tests failed, the next person would have no way to see what
 * the fixture actually contained, let alone change one cell of it. So the
 * fixtures are BUILT HERE, from a description that reads like a table, and
 * the bytes are thrown away at the end of the test.
 *
 * The secondary benefit is honesty about the parser under test. This writer
 * shares no code with the reader -- it emits SpreadsheetML by hand -- so a
 * test that passes says the reader understands the file format, not that two
 * halves of the same library agree with each other.
 *
 * WHAT IS AND IS NOT IMPLEMENTED
 * Enough of SpreadsheetML to be opened by Excel and by `read-excel-file`:
 * shared strings, one worksheet part per sheet, three cell formats (general,
 * date, currency), formula cells with a cached `<v/>`, and `<mergeCells/>`.
 * No charts, no styling beyond number formats, no defined names, no pivot
 * tables -- none of which the importer looks at.
 *
 * This file lives under src/app/testing/, which tsconfig.app.json excludes,
 * so `fflate` stays a devDependency and never reaches the browser bundle.
 */

import { strToU8, zipSync } from 'fflate';

/**
 * One cell of a fixture sheet.
 *
 *   `string`                       a text cell (shared string)
 *   `number`                       a plain numeric cell, General format
 *   `null`                         no `<c/>` element at all -- a truly empty cell
 *   `{ currency }`                 numeric, with a `"$"#,##0.00` number format.
 *                                  This is how Excel stores money: the VALUE
 *                                  is 1250, the dollars and commas are
 *                                  presentation only.
 *   `{ dateSerial }`               numeric, with the built-in `m/d/yy` format
 *                                  (numFmtId 14). 45678 is 1 January 2025.
 *                                  Unformatted, this is the cell that turns a
 *                                  purchase date into the number 45678.
 *   `{ formula, cachedNumber }`    `<f/>` plus a cached numeric `<v/>`
 *   `{ formula, cachedText }`      `<f/>` plus a cached string result
 *                                  (`t="str"`, the way Excel writes it)
 *   `{ formula }`                  a formula with NO cached value, which is
 *                                  what a file written by a non-Excel tool
 *                                  can look like
 */
export type FixtureCell =
  | string
  | number
  | null
  | { currency: number }
  | { dateSerial: number }
  | { formula: string; cachedNumber?: number; cachedText?: string };

export interface FixtureSheet {
  /** Worksheet (tab) name, as it appears in Excel. */
  name: string;
  /** Rows of cells. An empty array is a row Excel wrote but left blank. */
  rows: FixtureCell[][];
  /** Merged ranges in A1 notation, e.g. `['A1:B1']`. */
  merges?: string[];
}

/** Style indexes written into `xl/styles.xml` below, in this order. */
const STYLE_GENERAL = 0;
const STYLE_DATE = 1;
const STYLE_CURRENCY = 2;

/** Build a complete `.xlsx` workbook as bytes. */
export function buildXlsxWorkbook(sheets: FixtureSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('a workbook needs at least one sheet');

  // Shared strings are collected across every sheet, exactly as Excel does,
  // so the importer exercises the index-into-a-dictionary path rather than
  // the much rarer inline-string one.
  const sharedStrings: string[] = [];
  const sharedStringIndex = new Map<string, number>();
  const internString = (text: string): number => {
    const existing = sharedStringIndex.get(text);
    if (existing !== undefined) return existing;
    const index = sharedStrings.length;
    sharedStrings.push(text);
    sharedStringIndex.set(text, index);
    return index;
  };

  const sheetXml = sheets.map(sheet => renderSheet(sheet, internString));

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(sheets.length)),
    '_rels/.rels': strToU8(rootRels()),
    'xl/workbook.xml': strToU8(workbook(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels(sheets.length)),
    'xl/styles.xml': strToU8(styles()),
    'xl/sharedStrings.xml': strToU8(sharedStringsXml(sharedStrings))
  };
  sheetXml.forEach((xml, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(xml);
  });

  return zipSync(files, { level: 0 });
}

/**
 * Convenience for the common case: one sheet described as a header row plus
 * data rows of plain text, which is what most of the mapping tests need.
 */
export function buildSimpleXlsx(
  sheetName: string,
  headerRow: string[],
  dataRows: FixtureCell[][]
): Uint8Array {
  return buildXlsxWorkbook([{ name: sheetName, rows: [headerRow, ...dataRows] }]);
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let letters = '';
  let remaining = index;
  while (remaining >= 0) {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return letters;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCell(
  reference: string,
  cell: FixtureCell,
  internString: (text: string) => number
): string {
  if (cell === null || cell === undefined) return '';

  if (typeof cell === 'number') {
    return `<c r="${reference}" s="${STYLE_GENERAL}"><v>${cell}</v></c>`;
  }

  if (typeof cell === 'string') {
    // An empty string still gets a cell, so a deliberately blank header can
    // be told apart from a column that does not exist.
    return `<c r="${reference}" s="${STYLE_GENERAL}" t="s"><v>${internString(cell)}</v></c>`;
  }

  if ('currency' in cell) {
    return `<c r="${reference}" s="${STYLE_CURRENCY}"><v>${cell.currency}</v></c>`;
  }

  if ('dateSerial' in cell) {
    return `<c r="${reference}" s="${STYLE_DATE}"><v>${cell.dateSerial}</v></c>`;
  }

  // Formula. Excel writes a numeric result as the default type with a cached
  // <v/>, and a text result as t="str".
  const formula = `<f>${escapeXml(cell.formula)}</f>`;
  if (cell.cachedText !== undefined) {
    return `<c r="${reference}" s="${STYLE_GENERAL}" t="str">${formula}` +
      `<v>${escapeXml(cell.cachedText)}</v></c>`;
  }
  if (cell.cachedNumber !== undefined) {
    return `<c r="${reference}" s="${STYLE_GENERAL}">${formula}<v>${cell.cachedNumber}</v></c>`;
  }
  return `<c r="${reference}" s="${STYLE_GENERAL}">${formula}</c>`;
}

function renderSheet(sheet: FixtureSheet, internString: (text: string) => number): string {
  const rows = sheet.rows.map((cells, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const rendered = cells
      .map((cell, columnIndex) =>
        renderCell(`${columnLetter(columnIndex)}${rowNumber}`, cell, internString))
      .join('');
    // A row with no cells is written as a self-closing <row/>, which is
    // exactly what Excel leaves behind when a row is typed into and cleared.
    return rendered ? `<row r="${rowNumber}">${rendered}</row>` : `<row r="${rowNumber}"/>`;
  }).join('');

  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">` +
      sheet.merges.map(range => `<mergeCell ref="${escapeXml(range)}"/>`).join('') +
      '</mergeCells>'
    : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData>${merges}</worksheet>`;
}

function contentTypes(sheetCount: number): string {
  const sheetOverrides = Array.from({ length: sheetCount }, (_unused, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ' +
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetOverrides +
    '<Override PartName="/xl/styles.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>';
}

function rootRels(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="xl/workbook.xml"/>' +
    '</Relationships>';
}

function workbook(sheets: FixtureSheet[]): string {
  const entries = sheets.map((sheet, index) =>
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${entries}</sheets></workbook>`;
}

function workbookRels(sheetCount: number): string {
  const base = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const sheetRels = Array.from({ length: sheetCount }, (_unused, index) =>
    `<Relationship Id="rId${index + 1}" Type="${base}worksheet" ` +
    `Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetRels +
    `<Relationship Id="rIdStyles" Type="${base}styles" Target="styles.xml"/>` +
    `<Relationship Id="rIdStrings" Type="${base}sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>';
}

function styles(): string {
  // numFmtId 14 is the built-in `m/d/yy`; 164 is the first id available for a
  // custom format, which is where the currency template goes. The importer
  // decides a cell is a date by looking the style's numFmtId up, so these two
  // entries are the whole reason this part exists.
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1">' +
    '<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>' +
    '</numFmts>' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '</styleSheet>';
}

function sharedStringsXml(strings: string[]): string {
  const items = strings
    // xml:space="preserve" so a header that is deliberately " " survives.
    .map(text => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
    .join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    `count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}
