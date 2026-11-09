import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { describeHttpError, resolveApiBaseUrl } from '../http-utils';
import { RecordedError } from './recent-errors.service';

/**
 * SupportService — the browser half of "Help → Report a problem".
 *
 * ---- WHAT THIS DOES AND DOES NOT DO ----
 * It asks the backend for a report, asks the backend to write a zip, and
 * opens a URL. It does NOT talk to GitHub, hold a credential, or send
 * anything anywhere on its own. Every call here is the direct result of the
 * user pressing a button they could read first.
 *
 * ---- WHY ATTACHMENTS TRAVEL AS BASE64 AND NOT AS PATHS ----
 * The browser cannot tell the server "read C:\Users\dave\holdings.qif" — and
 * it must not be able to. An endpoint that reads a path the renderer names
 * is an arbitrary-file reader reachable by any local process, which is the
 * problem §4.10 of the packaging design raises about /api/images/file. The
 * file input already hands us the bytes; sending them is both safer and
 * less code.
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

export interface SupportLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface SupportPreview {
  markdown: string;
  receipt: RedactionReceiptEntry[];
  outputDirectory: string;
  repositoryUrl: string;
  /** False while the repository URL is still the shipped placeholder. */
  repositoryConfigured: boolean;
  limits: SupportLimits;
}

/** A file the user explicitly chose, already read into memory. */
export interface ChosenAttachment {
  name: string;
  bytes: number;
  contentBase64: string;
}

export interface BundleResult {
  path: string;
  fileName: string;
  directory: string;
  bytes: number;
  entries: string[];
  receipt: RedactionReceiptEntry[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * The subset of `File` this feature needs.
 *
 * Declared structurally so the unit tests can hand in a plain object. The
 * frontend test suite runs under Node with no jsdom, so there is no `File`
 * constructor available — and depending on one would make the most
 * important logic in this feature untestable.
 */
export interface FileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Bytes to base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a multi-megabyte array throws
 * "Maximum call stack size exceeded" — spreading a large array into
 * arguments is the classic way to blow the stack. The user's spreadsheet is
 * exactly the size where that starts happening, so this is not theoretical.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

@Injectable({ providedIn: 'root' })
export class SupportService {
  // Constructor injection rather than inject(), matching LoggingService: it
  // lets a test build the service with a stub HttpClient without standing up
  // an injection context.
  constructor(private readonly http: HttpClient) {}

  private readonly baseUrl = resolveApiBaseUrl();

  /**
   * Build the report. Writes nothing — this is the preview step, and the
   * user has consented to nothing yet.
   */
  async preview(input: {
    userDescription?: string;
    clientErrors?: readonly RecordedError[];
    attachments?: ReadonlyArray<{ name: string; bytes: number }>;
  }): Promise<SupportPreview> {
    try {
      return await firstValueFrom(
        this.http.post<SupportPreview>(`${this.baseUrl}/api/support/preview`, {
          userDescription: input.userDescription,
          clientErrors: input.clientErrors ?? [],
          attachments: input.attachments ?? []
        })
      );
    } catch (err) {
      throw new Error(`Could not build the report: ${describeHttpError(err)}`);
    }
  }

  /** Write the zip. Only ever called after the user has read the text. */
  async createBundle(
    markdown: string,
    attachments: readonly ChosenAttachment[]
  ): Promise<BundleResult> {
    try {
      return await firstValueFrom(
        this.http.post<BundleResult>(`${this.baseUrl}/api/support/bundle`, {
          markdown,
          attachments: attachments.map(a => ({ name: a.name, contentBase64: a.contentBase64 }))
        })
      );
    } catch (err) {
      throw new Error(`Could not save the report file: ${describeHttpError(err)}`);
    }
  }

  /** Read a chosen file into memory, ready to send. */
  async readFile(file: FileLike): Promise<ChosenAttachment> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return { name: file.name, bytes: bytes.length, contentBase64: bytesToBase64(bytes) };
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
