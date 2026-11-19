import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { describeHttpError, resolveApiBaseUrl } from '../http-utils';
import { RecordedError } from './recent-errors.service';

/**
 * Browser side of "Help > Report a problem". Asks the backend for the issue
 * repository config, builds a report preview, writes the report (and optional
 * log) to files, and opens the pre-filled issue URL. It never contacts GitHub
 * or holds a credential; files are attached by dragging them into the issue.
 */

/** What the backend says it took out of the report. */
export interface RedactionReceiptEntry {
  placeholder: string;
  what: string;
  occurrences: number;
}

/**
 * Where issues go and where the file will be written. Fetched on its own
 * because the dialog's first screen shows the repository link.
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
 * The `.txt` of recent log lines written beside the report when "Include
 * recent log" is ticked, redacted by the same pass as the report.
 */
export interface SavedLogFile {
  /** The real path, for the user's own screen; not for the issue body. */
  path: string;
  /** The path with the user name replaced; this one goes in the public issue. */
  redactedPath: string;
  fileName: string;
  bytes: number;
}

/** The `.md` report the server wrote to the Desktop. */
export interface SavedReport {
  /** The real path, for the user's own screen; not for the issue body. */
  path: string;
  /** The path with the user name replaced; this one goes in the public issue. */
  redactedPath: string;
  fileName: string;
  directory: string;
  bytes: number;
  /** The log file the server actually wrote, or null when not requested. */
  log: SavedLogFile | null;
  receipt: RedactionReceiptEntry[];
}

@Injectable({ providedIn: 'root' })
export class SupportService {
  // Constructor injection so tests can pass a stub HttpClient.
  constructor(private readonly http: HttpClient) {}

  private readonly baseUrl = resolveApiBaseUrl();

  /** Where issues are filed. */
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
   * Builds the report without writing anything. Used for the dialog's preview
   * and to produce the text that is saved.
   */
  async preview(input: {
    userDescription?: string;
    clientErrors?: readonly RecordedError[];
    /** Always sent explicitly: it changes the report body, so preview and saved file must agree. */
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
   * Writes the `.md` report, plus the `.txt` log when asked. The server reads
   * the log itself, so the unredacted log never passes through the browser.
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

  /** Copies text to the clipboard; returns false if the browser refuses. */
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
