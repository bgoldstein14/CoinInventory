import fs from 'fs';
import path from 'path';

/**
 * Simple file-based logger for the Express backend.
 * Writes timestamped log entries to server/logs/app.log
 * and echoes to console for visibility during development.
 */

// Log file lives alongside the server code
const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

// Ensure the logs directory exists on first import
// This runs once when the module is loaded
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Appends a timestamped line to the log file.
 * Uses appendFileSync so log writes are immediate and ordered.
 *
 * @param level - Log level: 'INFO', 'WARN', or 'ERROR'
 * @param message - The main log message
 * @param details - Optional additional details (often error stack traces)
 */
export function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: string): void {
  const timestamp = new Date().toISOString();
  const line = details
    ? `[${timestamp}] [${level}] ${message} | ${details}\n`
    : `[${timestamp}] [${level}] ${message}\n`;

  // Try to write to file first
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // If we can't write to the log file, fall back to console
    // This ensures logging never crashes the app
    console.error(`[LOG WRITE FAILED] ${line}`);
  }

  // Also echo to console so dev-mode output is visible
  // ERROR logs go to console.error, others to console.log
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

/**
 * Convenience function for INFO-level logs
 */
export function logInfo(message: string): void {
  log('INFO', message);
}

/**
 * Convenience function for WARN-level logs
 */
export function logWarn(message: string): void {
  log('WARN', message);
}

/**
 * Convenience function for ERROR-level logs with optional error details
 * If err is an Error object, extracts and formats message + stack trace
 *
 * @param message - The main error message
 * @param err - Optional error object or string
 */
export function logError(message: string, err?: unknown): void {
  // Format error details: if it's an Error, extract message and stack
  // Otherwise just convert to string
  const details = err instanceof Error ? `${err.message}\n${err.stack}` : String(err ?? '');
  log('ERROR', message, details);
}
