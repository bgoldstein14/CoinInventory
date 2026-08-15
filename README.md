# Coin Inventory

A polished Angular coin inventory and valuation application designed for collectors and dealers. The app provides inventory tracking, Quicken import parsing, automatic image-to-coin matching, and a clean dashboard for coin metadata, grading, certification, and value management.

## Features

- Coin inventory dashboard with summary cards for collection size, cost basis, and current value
- Detailed coin profile fields including denomination, type, country, grade, variety, mint mark, composition, notes, and certification details
- Quicken import support for QIF-style account import data to auto-populate coin records and values
- Image-association workflow that scans a folder of files and matches names to known inventory entries
- Unmatched image detection so uncertain matches can be reviewed manually
- Collection-friendly layout intended for coin collectors, dealers, and numismatic enthusiasts
- Angular + TypeScript foundation for maintainable, extensible code

## Tech stack

- Angular 22
- TypeScript
- SCSS
- Vitest for unit testing

## Prerequisites

- Node.js 20+ recommended
- npm 10+

## Run locally

From the project root:

```powershell
cd "D:\Documents\Development\Coin Inventory"
npm install
npm start -- --host 0.0.0.0
```

Then open the local URL shown in the Angular CLI output, commonly:

```text
http://localhost:4200
```

## Build for production

```powershell
cd "D:\Documents\Development\Coin Inventory"
npm run build
```

## Test

```powershell
cd "D:\Documents\Development\Coin Inventory"
npm test
```

## Notes

This project is intentionally structured so it can be expanded with a real database, CRUD editing forms, export tools, valuation integrations, and stronger filename normalization for more advanced image matching.
