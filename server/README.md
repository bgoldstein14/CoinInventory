# Coin Inventory Server

SQL Server backend for the Coin Inventory Angular application.

## Prerequisites

- Node.js 18+
- SQL Server (local or remote)

## Database Setup

1. Open SQL Server Management Studio (or `sqlcmd`).
2. Execute `schema.sql` to create the database and tables:
   ```
   sqlcmd -S localhost -i schema.sql
   ```

## Configuration

1. Copy `.env.example` to `.env`:
   ```
   copy .env.example .env
   ```
2. Edit `.env` with your SQL Server connection details.
   - For Windows Authentication leave `DB_USER` and `DB_PASSWORD` blank.
   - For SQL Server Authentication fill in both fields.

## Running

```bash
# Install dependencies
npm install

# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

The server starts on `http://localhost:3000` by default.

## How the Angular App Connects

During development, run `ng serve` with a proxy that forwards `/api` requests
to the server. Create `proxy.conf.json` in the Angular project root:

```json
{
  "/api": {
    "target": "http://localhost:3000",
    "secure": false
  }
}
```

Then start Angular with: `ng serve --proxy-config proxy.conf.json`

For production, build the Angular app (`ng build`) and the server will serve
the compiled files from `../dist/coin-inventory-app/browser` as static assets.
