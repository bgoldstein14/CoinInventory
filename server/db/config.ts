/**
 * db/config.ts — builds the SQL Server connection configuration object.
 *
 * This file owns ONE job: turn the environment variables in server/.env into
 * the `sql.config` object that the connection pool is constructed from. It does
 * not open connections and it holds no state, which makes it trivial to unit
 * test (see db/connection.spec.ts).
 *
 * The pool sizing and timeout numbers below are part of the fix for the crash
 * described in db/index.ts — read that header first if you are wondering why
 * this backend is arranged the way it is.
 */

import sql from 'mssql';

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

    // How long we wait for the initial TCP + login handshake before giving up.
    connectionTimeout: 15000,
    // How long a single query may run before mssql aborts it.
    requestTimeout: 30000,

    pool: {
      // Never more than 10 sockets open against SQL Server at once.
      max: 10,
      // IMPORTANT: min: 1 keeps one warm connection alive. Without it the pool
      // drains to zero while the user is idle, and the very next edit has to
      // build a brand new connection — which is exactly when the old code used
      // to blow up.
      min: 1,
      // An idle connection above `min` is closed after 60s.
      idleTimeoutMillis: 60000,
      // If every connection is busy, wait at most 15s for one to free up
      // instead of hanging the HTTP request forever.
      acquireTimeoutMillis: 15000,
    },

    options: {
      encrypt: false,
      trustServerCertificate: true,
      // Recommended by the tedious driver; makes arithmetic overflow/divide-by-zero
      // abort the statement rather than silently returning NULL.
      enableArithAbort: true,
    },
  };

  if (!useWindowsAuth) {
    config.user = user;
    config.password = process.env['DB_PASSWORD'];
  }

  return config;
}
