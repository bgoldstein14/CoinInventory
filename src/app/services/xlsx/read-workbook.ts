 /*
  * The only module that touches the spreadsheet parser, `read-excel-file`.
  *
  * Chosen over SheetJS (`xlsx`), whose npm release (0.18.5) carries unfixed
  * advisories triggered by reading crafted files (CVE-2023-30533,
  * CVE-2024-22363; patched builds only on the vendor CDN), and over ExcelJS
  * (Node-oriented, ~1 MB browser bundle, also writes). read-excel-file is MIT,
  * browser-first, read-only, has a small dependency tree, and understands number
  * formats, which is how serial 45678 is known to be a date.
  *
  * Imported dynamically so the parser is a lazy chunk outside the initial bundle.
  * The `/universal` entry takes an ArrayBuffer and works in Node, so specs can run it.
  * Parsing happens in the browser to avoid an upload route on the server.
  */

import { RawWorksheet, toWorkbookSheets, WorkbookSheet } from './workbook-sheets';

/**
 * Reads an `.xlsx` workbook into one `WorkbookSheet` per worksheet, in workbook
 * order. Sheets with nothing importable are marked, not omitted.
 *
 * @param data the raw file bytes, e.g. `await file.arrayBuffer()`
 * @throws a user-readable message (e.g. for a renamed `.csv` or an old `.xls`),
 *   not the parser's own error
 */
export async function readWorkbook(data: ArrayBuffer): Promise<WorkbookSheet[]> {
  // Lazily loaded; keep this the only reference to the parser in the app.
  const { default: readXlsxFile } = await import('read-excel-file/universal');

  let parsed: { sheet: string; data: unknown[][] }[];
  try {
    parsed = await readXlsxFile(data) as { sheet: string; data: unknown[][] }[];
  } catch {
    throw new Error(
      'That file could not be read as an Excel workbook. ' +
      'Only .xlsx files are supported — if yours is an older .xls, or a CSV ' +
      'that has been renamed, open it in Excel and use Save As to produce ' +
      'an .xlsx first.'
    );
  }

  return toWorkbookSheets(parsed as unknown as RawWorksheet[]);
}
