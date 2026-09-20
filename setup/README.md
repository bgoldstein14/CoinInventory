# Coin Inventory setup

This folder contains the Windows launchers used to start the app reliably and open the default browser.

## Preferred startup

Double-click `launch-coin-inventory.cmd` in the project root.

The launcher itself is `start-coin-inventory.ps1` in the **project root**.
`setup\start-coin-inventory.ps1` is now just a shim that forwards to it, so
the older entry points below still work:

### PowerShell
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-coin-inventory.ps1
```

### Command prompt
```cmd
setup\start-coin-inventory.cmd
```

## What the launcher does
- checks for Node.js, offering `install-node.ps1` if it is missing
- installs dependencies **only when `node_modules` is absent** (not on every run)
- starts the backend server (port 3000) and the frontend app (port 4200)
- waits until **both** are ready — the backend is probed via `GET /api/health`,
  which returns 200 only after SQL Server has answered a `SELECT 1`
- opens the app in Edge, and stops the servers when you close it

## Notes
- There used to be two separate launchers, one here and one in the project
  root, with different readiness checks and different lock files. Running
  both started two sets of servers competing for ports 3000 and 4200. They
  are now a single implementation.
- The old launcher only waited for port 4200 (the Angular dev server) before
  opening the browser. The app hydrates from the database exactly once at
  startup, so whenever the API lost that race you saw a spurious
  "Cannot connect to database" error. Waiting on `/api/health` fixes it.
- If the app still fails to connect to SQL Server, run the backend directly from the server directory:
  ```powershell
  cd server
  npx tsx server.ts
  ```
- The app depends on the local SQL Server database and the setup script in `server/setup-database.sql` for the canonical lookup data.
