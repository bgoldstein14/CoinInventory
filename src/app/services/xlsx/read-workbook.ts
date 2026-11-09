 /*
 * read-workbook.ts — the only place that touches the spreadsheet parser.
 * ---- WHICH PARSER, AND WHY ----
 * `read-excel-file`, not SheetJS (`xlsx`) and not ExcelJS.
 *
 * SheetJS is the obvious first choice and was rejected on security. Its
 * distribution moved off npm, so `npm install xlsx` still resolves to
 * 0.18.5 -- a build with two unfixed advisories against it:
 *
 *   CVE-2023-30533  prototype pollution, fixed in 0.19.3
 *   CVE-2024-22363  regular-expression denial of service, fixed in 0.20.2
 *
 * GitHub's advisory database reports NO non-vulnerable version available
 * through npm, because the patched builds are published only on the
 * vendor's own CDN. Both bugs are triggered by READING a crafted file,
 * which is precisely and exclusively what this module does, with a file
 * chosen by the user. This app is heading for public distribution to
 * non-technical people, so "we pin a tarball from a CDN and hope nobody
 * re-runs npm install" is not a maintenance story worth having.
 *
 * ExcelJS is maintained and MIT, and is built for Node: `archiver`,
 * `unzipper`, `tmp`, `readable-stream`, `fast-csv`. Using it in a browser
 * means its pre-bundled dist, which is around a megabyte -- against an
 * initial bundle already at 724 kB and a 1 MB hard budget -- and it writes
 * workbooks as well as reads them, which is capability this feature does
 * not want and would still have to carry.
 *
 * `read-excel-file` is MIT, released within the last month, browser-first,
 * and read-only. Its dependency tree is four small packages (`fflate`,
 * `saxen`, `unzipper-esm`, `worker-f`) and `npm audit` reports nothing
 * against any of them. It understands number formats, which is the one
 * capability that actually matters here -- it is how a cell holding 45678
 * is known to be 21 January 2025 rather than the number forty-five
 * thousand.
 *
 * ---- WHY THE IMPORT IS DYNAMIC ----
 * `await import(...)` rather than a top-level import, so the parser lands in
 * its own lazily-fetched chunk instead of the initial bundle. The initial
 * bundle is 724 kB against a 500 kB warning and a 1 MB error, and most
 * sessions never open the import dialog at all. The cost is paid by the one
 * click that needs it.
 *
 * The `/universal` entry point is the one that takes an `ArrayBuffer` and
 * works in both a browser and Node. That matters for more than tidiness:
 * frontend specs here run under Node with no jsdom, so the `/browser` entry
 * (which reaches for `FileReader`) could not be tested at all, and testing
 * the `/node` entry would mean shipping a code path no user ever runs.
 *
 * ---- WHY PARSING HAPPENS IN THE BROWSER ----
 * This is a local single-user app. Uploading the workbook to the Express
 * side would add a file-upload route, a temp-file lifecycle and a new
 * untrusted-input surface on the server, in exchange for nothing the user
 * can perceive.
  */

import { RawWorksheet, toWorkbookSheets, WorkbookSheet } from './workbook-sheets';

/**
 * Read an `.xlsx` workbook into one `WorkbookSheet` per worksheet, in
 * workbook order.
 *
 * Sheets that hold nothing importable come back marked rather than omitted
 * -- see workbook-sheets.ts for why a tab must never silently disappear.
 *
 * @param data the raw bytes of the file, e.g. `await file.arrayBuffer()`
 * @throws a message written for the person holding the file, never the
 *   parser's own wording. The underlying failure for a `.csv` renamed to
 *   `.xlsx`, or for a genuine 1990s `.xls`, is about zip central
 *   directories, which tells a collector nothing at all.
 */
export async function readWorkbook(data: ArrayBuffer): Promise<WorkbookSheet[]> {
  // Lazily loaded; see the header. Keep this the only reference to the
  // parser anywhere in the app.
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
