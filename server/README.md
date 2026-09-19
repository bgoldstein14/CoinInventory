# Coin Inventory Server

SQL Server-backed API layer for the Coin Inventory Angular application.

## Prerequisites

- Node.js 22+
- SQL Server Express or a reachable local SQL Server instance
- Windows authentication is the default development path

## Database setup

Use the project SQL setup script to create the database and seed the canonical reference data:

```powershell
sqlcmd -S localhost -d master -E -i .\setup-database.sql
```

This script creates the database, tables, categories, denominations, mint marks, metal contents, and related seed data. It is the authoritative source for database initialization; the app no longer relies on runtime seeding logic.

## Configuration

Create or update your `.env` file in the `server` folder with:

```env
DB_SERVER=localhost
DB_NAME=CoinInventory
DB_USER=
DB_PASSWORD=
PORT=3000
```

For named instances, use the full server name, such as:

```env
DB_SERVER=BRUCE_PC\SQLEXPRESS
```

## Running

```powershell
cd server
npm install
npx tsx server.ts
```

The server listens on port 3000 by default.

## Notes

- The backend uses a lazy singleton SQL pool and is more resilient to reboot-time host/port drift.
- Categories, denominations, mint marks, and metal contents are expected to be loaded from SQL and kept in sync with the app.
- The frontend and backend should be started through the project launcher when possible; use the direct `tsx` command only for troubleshooting or manual startup.
