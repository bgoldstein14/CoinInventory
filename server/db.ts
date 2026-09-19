/**
 * Database configuration, connection pool, and shared helper functions.
 *
 * All route modules import getPool() from here to access SQL Server.
 * The pool is a lazy singleton — created on first request, reused after that.
 */

import sql from 'mssql';
import { logInfo, logError } from './logger';

// ============================================================
// Configuration
// ============================================================

/**
 * Builds the SQL Server connection configuration.
 * Uses Windows Authentication if DB_USER is not set.
 * For named instances (e.g., BRUCE_PC\SQLEXPRESS), port is omitted — SQL Browser handles resolution.
 */
export function buildDbConfig(): sql.config {
  const user = process.env['DB_USER'];
  const useWindowsAuth = !user;

  let server = (process.env['DB_SERVER'] ?? 'localhost').trim();
  let port = parseInt(process.env['DB_PORT'] ?? '', 10);

  // Handle SSMS-style "server,port" syntax (e.g. "localhost,1433") even when
  // DB_PORT is already set, because some environments persist a comma-suffixed server value.
  if (server.includes(',')) {
    const [serverPart, portPart] = server.split(',');
    server = serverPart.trim();
    const parsedPort = parseInt(portPart.trim(), 10);
    if (!Number.isNaN(parsedPort)) {
      port = parsedPort;
    }
  }

  const config: sql.config = {
    server,
    database: process.env['DB_NAME'] ?? 'CoinInventory',
    ...(port ? { port } : {}),
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  };

  if (!useWindowsAuth) {
    config.user = user;
    config.password = process.env['DB_PASSWORD'];
  }

  return config;
}

// ============================================================
// Connection pool (lazy singleton)
// ============================================================

let pool: sql.ConnectionPool | null = null;

/**
 * Gets or creates the SQL Server connection pool.
 * Logs connection attempts and errors for debugging.
 */
export async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    const config = buildDbConfig();
    logInfo(`Connecting to SQL Server at ${config.server}/${config.database}...`);
    try {
      pool = await sql.connect(config);
      logInfo('Connected to SQL Server successfully');
    } catch (err) {
      logError('Failed to connect to SQL Server', err);
      throw err;
    }
  }
  return pool;
}

// ============================================================
// Helpers shared across route modules
// ============================================================

/**
 * Maps a database row (CamelCase SQL columns) to a camelCase JavaScript coin object.
 * Used by the coins routes when reading from the Coins table.
 */
export function rowToCoin(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['CoinId'],
    denomination: row['Denomination'] ?? '',
    year: row['Year'] ?? '',
    coinType: row['CoinType'] ?? '',
    category: row['Category'] ?? '',
    country: row['Country'] ?? '',
    grade: row['Grade'] ?? '',
    certCompany: row['CertCompany'] ?? '',
    certNumber: row['CertNumber'] ?? '',
    variety: row['Variety'] ?? '',
    mintMark: row['MintMark'] ?? '',
    composition: row['Composition'] ?? '',
    purchaseDate: row['PurchaseDate'] ?? '',
    purchasePrice: row['PurchasePrice'] ?? 0,
    currentValue: row['CurrentValue'] ?? 0,
    notes: row['Notes'] ?? '',
    source: row['Source'] ?? 'manual',
    hasCacSticker: row['HasCacSticker'] === true || row['HasCacSticker'] === 1,
    soldPrice: row['SoldPrice'] ?? undefined,
    soldDate: row['SoldDate'] ?? undefined,
    dealer: row['Dealer'] ?? undefined,
    weight: row['Weight'] ?? undefined,
    metalContent: row['MetalContent'] ?? undefined,
    pmWeightGrams: row['PmWeightGrams'] ?? undefined,
    pmPercent: row['PmPercent'] ?? undefined,
    coinSet: row['CoinSet'] ?? undefined,
  };
}

/**
 * Formats a Date or string to YYYY-MM-DD string.
 * SQL Server returns Date objects; this normalizes them for JSON responses.
 */
export function formatDate(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}
