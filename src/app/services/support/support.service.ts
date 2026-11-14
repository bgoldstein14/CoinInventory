import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { describeHttpError, resolveApiBaseUrl } from '../http-utils';
import { RecordedError } from './recent-errors.service';

/**
 * SupportService — the browser half of "Help → Report a problem".
 *
 * ---- WHAT THIS DOES AND DOES NOT DO ----
 * It asks the backend where issues are filed, asks it for a report, asks it
 * to write that report to a file, and opens a URL. It does NOT talk to
 * GitHub, hold a credential, or send anything anywhere on its own. Every
 * call here is the direct result of the user pressing a button they could
 * read first.
 *
 * ---- THERE IS NO UPLOAD, AND THEREFORE NO FILE READING ----
 * This service used to read files the user picked and send them to the
 * server as base64, to be put in a zip. There is no zip any more, and the
 * app cannot upload to GitHub — there is no official attachment API, only
 * undocumented routes that disagree about whether a token even works — so
 * there was nowhere left for those bytes to go. Reading a user's QIF into
 * memory and then dropping it would be worse than never offering, so the
 * picker, the staging list, the base64 encoder and the size caps were all
 * removed rather than left pointing at nothing.
 *
 * Files reach the issue by the user dragging them in on GitHub. The dialog
 * says so, and gives them the link.
 *
 * It is imported from './http-utils' rather than './api.service' for the
 * reason that file's header gives: pulling in ApiService drags Angular's XHR
 * backend into the module graph and breaks unit tests that do not bootstrap
 * the JIT compiler.
 */

/** What the backend says it took out of the report. */
export interface RedactionReceiptEntry {
  placeholder: string;
  what: string;
  occurrences: number;
}

/**
 * Where issues go and where the file will land.
 *
 * Fetched on its own, before anything is built, because the dialog's FIRST
 * screen offers the repository as a clickable link. Building the report to
 * find out a URL would read the log and query the database for nothing.
 */
export interface SupportConfig {
  repositoryUrl: string;
  /** False while the repository URL is still the shipped placeholder. */
  repositoryConfigured: boolean;
  outputDirectory: string;
}

export interface SupportPreview {
  markdown: string;
  receipt: RedactionReceiptEntry[];
}

/**
 * The plain `.txt` of recent log lines, written beside the report when the
 * reporter ticked "Include recent log". Redacted by the SAME pass as the
 * report, so a path reads identically in both files.
 */
export interface SavedLogFile {
  /** The real path, for the user's own screen. Not for the issue body. */
  path: string;
  /** The same path with the user name replaced. THIS one goes in the issue. */
  redactedPath: string;
  fileName: string;
  bytes: number;
}

/** The plain `.md` file the server wrote to the Desktop. */
export interface SavedReport {
  /** The real path, for the user's own screen. Not for the issue body. */
  path: string;
  /**
   * The same path with the user name replaced. THIS is the one that goes
   * into the issue body, because the issue is public.
   */
  redactedPath: string;
  fileName: string;
  directory: string;
  bytes: number;
  /**
   * The second file, or null when the reporter unticked the box.
   *
   * WHAT THE SERVER ACTUALLY WROTE, not what was asked for. The dialog says
   * "a log file was written and here it is" from this and nothing else, so
   * what the user is told always matches what is on their Desktop.
   */
  log: SavedLogFile | null;
  receipt: RedactionReceiptEntry[];
}

@Injectable({ providedIn: 'root' })
export class SupportService {
  // Constructor injection rather than inject(), matching LoggingService: it
  // lets a test build the service with a stub HttpClient without standing up
  // an injection context.
  constructor(private readonly http: HttpClient) {}

  private readonly baseUrl = resolveApiBaseUrl();

  /** Where issues are filed. Reads nothing and writes nothing. */
  async config(): Promise<SupportConfig> {
    try {
      return await firstValueFrom(
        this.http.get<SupportConfig>(`${this.baseUrl}/api/support/config`)
      );
    } catch (err) {
      throw new Error(`Could not read the support settings: ${describeHttpError(err)}`);
    }
  }

  /**
   * Build the report. Writes nothing.
   *
   * Called both to fill the dialog's optional "show me the exact text" box
   * and, immediately before writing, to produce the text that goes in the
   * file. Reaching it is not consent to anything: no artefact exists until
   * `saveReport` is called.
   */
  async preview(input: {
    userDescription?: string;
    clientErrors?: readonly RecordedError[];
    /**
     * Sent EXPLICITLY, never left to the server's default. It changes the
     * report body — unticked means the 150-line tail is not in it either —
     * so a request that omitted it would show the user a preview of a
     * different document from the one they are about to write.
     */
    includeLog: boolean;
  }): Promise<SupportPreview> {
    try {
      return await firstValueFrom(
        this.http.post<SupportPreview>(`${this.baseUrl}/api/support/preview`, {
          userDescription: input.userDescription,
          clientErrors: input.clientErrors ?? [],
          includeLog: input.includeLog
        })
      );
    } catch (err) {
      throw new Error(`Could not build the report: ${describeHttpError(err)}`);
    }
  }

  /**
   * Write the `.md` file, and the `.txt` log beside it when asked.
   *
   * Only ever called from the dialog's submit button. The log lines are not
   * sent from here and never were: the server reads them itself, so the
   * unredacted log never passes through the browser.
   */
  async saveReport(markdown: string, includeLog: boolean): Promise<SavedReport> {
    try {
      return await firstValueFrom(
        this.http.post<SavedReport>(`${this.baseUrl}/api/support/report`, {
          markdown,
          includeLog
        })
      );
    } catch (err) {
      throw new Error(`Could not save the report file: ${describeHttpError(err)}`);
    }
  }

  /**
   * Put text on the clipboard. Returns false rather than throwing when the
   * browser refuses — the dialog then tells the user to copy it by hand
   * instead of pretending it worked.
   */
  async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Open the pre-filled issue in the user's own browser. */
  openIssue(url: string): void {
    window.open(url, '_blank', 'noopener');
  }
}
