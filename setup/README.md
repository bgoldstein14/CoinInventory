# Coin Inventory setup

This folder contains the Windows launchers used to start the app reliably and open the default browser.

## Preferred startup

### PowerShell
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup\start-coin-inventory.ps1
```

### Command prompt
```cmd
setup\start-coin-inventory.cmd
```

## What the launcher does
- checks for Node.js
- verifies the project directory
- installs dependencies if needed
- starts the backend server and frontend app
- opens the app in Edge
- optionally cleans up stale startup state before launching

## Notes
- This is the recommended startup path on Windows.
- If the app still fails to connect to SQL Server, run the backend directly from the server directory:
  ```powershell
  cd server
  npx tsx server.ts
  ```
- The app depends on the local SQL Server database and the setup script in `server/setup-database.sql` for the canonical lookup data.
