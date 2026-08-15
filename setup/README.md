# Coin Inventory setup

This folder contains a simple launcher for sharing the project with another person.

## Quick start for a friend

### Windows users
1. Double-click `start-coin-inventory.cmd`.
2. If Node.js is not installed, the script will tell them to install it or run `install-node.ps1`.
3. The app will install dependencies and start Angular.

### PowerShell users
1. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup\start-coin-inventory.ps1
   ```
2. The script will install dependencies and launch the app.

## What this does
- checks for Node.js
- runs `npm install` in the project root
- runs the Angular app on `http://localhost:4200`

## Notes
- This is a convenience launcher for local use.
- The actual project is still the Angular app under the main project folder.
