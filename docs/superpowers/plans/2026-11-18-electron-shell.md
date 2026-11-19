# Electron shell: execution plan

**Date:** 2026-11-18
**Status:** plan only. Nothing in this file has been built. The owner decisions in section 1 need answers before the tasks that depend on them start.
**Implements:** sequencing steps 6 (Electron shell, including the section 4.10 token) and 7 (installer) of `../specs/2026-10-31-desktop-packaging-design.md`.

Read these first. This plan follows the decisions in them and does not reopen them:

- `../specs/2026-10-31-desktop-packaging-design.md` (the design; section numbers below refer to it unless stated otherwise)
- `2026-11-13-sqlite-migration.md`, especially "Cross-platform"
- `2026-11-14-dealer-readiness.md`, especially section 16 (backup reinstated) and section 17 (dependency rules, build-time overrides)
- `server/README.md` (its environment-variable table is the complete list of what the backend reads)
- `docs/architecture.md`, `docs/rationale/server.md`

`docs/going-public-checklist.md` is **not in this working copy**. `.gitignore` keeps it out of version control on purpose, so nothing in this plan relies on it.

---

## 0. How to use this plan

- Section 1 lists the decisions that belong to the owner. Each has options, trade-offs and a recommended default. If the owner has not answered, **build the recommended default.** Each one is written so that changing it later stays contained.
- Sections 2 and 3 cover what is already done and what reading the code turned up. Read them before writing anything. Several findings are bugs the shell would expose on day one.
- Sections 4 to 10 are the design, topic by topic.
- Section 11 is the task list. Every task lists the files it touches and how to check it. Do the tasks in order. Each one leaves `npm test`, `npm run test:server` and `npm run build` green, and leaves today's `npm start` browser workflow working.
- Sections 12 and 13 cover risks and what is out of scope.

### What was verified while writing this, and what was not

| Claim | Status |
|---|---|
| Latest stable Electron is **45.3.4** (2026-11-17). It bundles **Node 24.22.3** and Chromium 156. Electron 46 is in alpha and moves to Node 26. | **Verified** from `https://releases.electronjs.org/releases.json` |
| electron-builder latest is 26.18.0. @playwright/test latest is 1.65.1. Electron 45 needs Node >= 22.12 to *install*. | **Verified** with `npm view` |
| `node:sqlite` loads inside Electron. Electron PR #47706, "fix: missing SQLite builtin support in Node.js", was backported to the 36, 37 and 38 branches (PRs #47755-#47757), so 45 should include it. | **Not verified by running it.** The evidence is GitHub PR titles and third-party reports. Task 0.1 runs it for real. |
| `node:sqlite` loads inside a `utilityProcess` child | **Not verified.** Task 0.1. |
| `webUtils.getPathForFile(file)` returns real absolute paths, including for files from `<input webkitdirectory>` | Documented Electron API (29+; `File.path` was removed in 32). **Not verified against this app.** Task 0.1. |
| What Electron's `window.print()` shows (the Windows system dialog or a Chromium preview) | **Not verified.** Task 0.1. |
| Listening on `127.0.0.1` raises no Windows Defender Firewall prompt | Standard Windows behaviour (the prompt fires for listeners on non-loopback interfaces). **Not verified on a clean machine.** Release checklist. |
| What the SmartScreen warning says for this unsigned installer | **Not verifiable until an installer exists** and is downloaded on a clean VM. Section 4.11 of the design requires the README text to be written against what it actually says. |

No package was installed and no build was run while writing this plan. The only file created is this one.

---

## 1. Decisions for the owner

### Owner's answers (2026-11-18)

| # | Decision |
|---|---|
| D1 | **A** — `%LOCALAPPDATA%\CoinInventory` on Windows; `app.getPath('userData')` elsewhere. |
| D2 | **A** — auto-fill the base-folder box from the real picked folder; keep it visible and editable. |
| D3 | **A** — per-machine install, default `C:\Program Files\Coin Inventory`, folder changeable. |
| D4 | **A** — the host builds the installer and runs the shell; GitHub Actions later, once the repo is public. |
| D5 | Support repository: `https://github.com/bgoldstein14/CoinInventory`. |
| D6 | appId `io.github.bgoldstein14.coin-inventory` (confirmed; it can never change after the first release). Product name "Coin Inventory". Icon: the coin in the title bar, `public/coin-inventory-title.jpg`; that file is only 90×90, so the owner will supply a hi-res copy of the same image for the 256×256 `.ico`. Until then, build with the 90×90 image as a placeholder. Start Menu and desktop shortcuts. |
| D7 | **B** — open the original in the Windows default viewer via `shell.openPath`, with a bridge call that only accepts a path stored on that coin. |
| D8 | **Accept for v1** — Windows print dialog; Help text points to "Microsoft Print to PDF". |
| D9 | **Share** the collection file between `npm start` and the installed app; don't run both at once. |
| D10 | The app has no users yet, so browser-era preferences need no general migration. Provide a **one-time, developer-only** carry-over of the owner's own browser settings into the desktop app (e.g. a temporary export/import of the IndexedDB `AppSettings` and grid preferences), then drop it. |
| D11 | **Abandoned** — delete `server/migrate-sqlserver/`, `server/migrations/`, `server/setup-database.sql`, the server's `mssql`/`msnodesqlv8` packages and the root `msnodesqlv8`, and the specs that enforce keeping them (`db/driver-isolation.spec.ts`). |
| D12 | **A** — keep opening a newer-version file, and show a non-blocking notice. |
| Imports | Every import's default folder is the user's Documents folder. In the desktop app, every native open/folder dialog (CSV, Excel, QIF, batch images, backup restore) passes `defaultPath: app.getPath('documents')`, and the main process sets `COIN_DOCUMENTS_FOLDER` for the server from the same call. (The browser build already starts the image import's folder box at Documents via `GET /api/app-info`; browser file pickers cannot be pointed at a folder.) |

The sections below give the options and reasoning behind each.

Each item has a recommended default. **D1, D3 and D5 must be confirmed before release.** The rest can be built on the default.

### D1. Where the data folder is. Two of the owner's documents disagree.

Design section 4.10a fixes it at `%LOCALAPPDATA%\CoinInventory\`, "NOT changeable". The SQLite plan's Cross-platform section says "use `app.getPath('userData')`, never `process.env['LOCALAPPDATA']`". On Windows those are **different folders**. Electron's `userData` defaults to `%APPDATA%\<productName>`, which is the *Roaming* profile (`C:\Users\x\AppData\Roaming\Coin Inventory`), not `Local`.

| Option | Trade-offs |
|---|---|
| **A. `%LOCALAPPDATA%\CoinInventory` on Windows, `app.getPath('userData')` on every other platform.** The Windows path is resolved in one place, in the Electron main process, and passed to the server. The main process also calls `app.setPath('userData', ...)` so Electron's own storage sits under the same folder. | Honours section 4.10a exactly. The owner's existing `coin-inventory.db` is picked up with no migration. Local rather than Roaming matters: a database that can reach ~5 GB (section 4.9a) must not sit in a roaming profile that a corporate or family-PC setup may sync at logon. The Mac stays correct (`~/Library/Application Support/Coin Inventory`). It keeps one environment read, but in the shell rather than the server, which is what the Cross-platform note was really guarding against. |
| B. Electron's default `userData` everywhere | One rule for every platform. On Windows it lands in Roaming, contradicts section 4.10a, and the owner's current database would need a one-time move on first run. |

**Recommended: A.** The intent of the Cross-platform note ("Electron resolves all three correctly per platform") is kept, because the server stops reading `LOCALAPPDATA` itself and is told where to put things.

### D2. The image-import "base folder" box, now that real paths are available

In a browser the app never learns a file's real location. That is why the import screen asks for the base folder and joins it to `File.webkitRelativePath` (`src/app/services/image-import/source-path.ts`), and why there is a live preview and a hard guard (`base-folder-check.ts`). Inside Electron, `webUtils.getPathForFile(file)` gives the **true absolute path** of every picked file. This changes the screen's premise, so it is the owner's call, not something to redesign quietly.

| Option | Trade-offs |
|---|---|
| **A. Auto-fill and keep.** In the desktop app, each file's stored path is its real path. The base-folder box is filled automatically with the real folder the user picked. It stays visible and editable, and the preview and guard stay as they are. The browser behaviour does not change. | Smallest change. Nothing the owner has seen disappears. The "doubled folder name" rule and the guard become things that simply never trigger. The box is mostly redundant, but harmless. |
| B. Hide the box in the desktop app | Cleaner screen. More template and copy work. A user who wants to record a *different* prefix (for example a drive letter they will remap later) loses that ability. |
| C. Do nothing; keep typing the folder | No work. Throws away the one thing the shell fixes, and keeps the most expensive mistake that screen can make (section 4.4). |

**Recommended: A.** The backup and restore folder boxes (`src/app/services/backup/picked-folder.ts`) have the same "browser only tells us the name" problem. Section 7.2 has them use a native folder or file dialog in the desktop app, which returns a real path, empty folders included. That fills the existing box and changes nothing else, so it is treated as an implementation detail, not a separate decision. Tell the owner if you disagree.

### D3. Install scope: Program Files (needs admin) or per-user (no admin)

The owner said: "the default... should be `Program Files\Coin Inventory`". Installing into Program Files is a *per-machine* install and needs a Windows UAC elevation prompt. UAC is Windows asking, not the installer, but the user still sees it.

| Option | Trade-offs |
|---|---|
| **A. Per-machine (`perMachine: true`), default `C:\Program Files\Coin Inventory`, folder changeable** | What the owner asked for. One UAC prompt. A standard user without an admin password cannot install. Data is still per user under D1, so this has no effect on data. |
| B. Per-user, default `%LOCALAPPDATA%\Programs\Coin Inventory` | No UAC prompt, and any account can install. Not where the owner said. Each Windows account installs its own copy. |
| C. Let the installer ask "just me or everyone" | Adds a second question. Breaks goal 1 ("the only question it asks is where to install"). |

**Recommended: A**, as the owner stated. Revisit if real users report that they cannot install.

### D4. Which machine builds the installer (and runs the shell during development)

The author's corporate laptop **blocks native executables by group policy**. That is why `esbuild-wasm`, the pinned `sass` and `scripts/ng-wasm-safe.mjs` exist (dealer-readiness section 17). `electron.exe` is a native executable. So are electron-builder's helpers (`app-builder.exe`, `makensis.exe`, `7za.exe`). **They will almost certainly not run on that laptop.** The owner's host has no such restriction ("I'm wide open on my host").

| Option | Trade-offs |
|---|---|
| **A. The owner's host builds and runs the desktop app. The laptop keeps doing everything else** (front end, server, unit tests, the browser workflow) | Zero new infrastructure. Shell development and debugging happen on the host. The release is built by hand. |
| B. A GitHub Actions `windows-latest` runner builds the installer | Reproducible, and produces downloadable artefacts. Needs a workflow file, and is only free once the repo is public. Shell development still needs a machine that can run Electron. |

**Recommended: A for v1, with B added once the repo is public.** Task 0.1 also checks whether Electron really is blocked on the laptop. If it is not, the plan gets easier, but nothing depends on that.

### D5. The GitHub repository the Support button files issues against

`server/routes/support/index.ts` falls back to the placeholder `https://github.com/OWNER/coin-inventory` and reports `repositoryConfigured: false`. Inside an installer no user can set `SUPPORT_REPO_URL`, so the real URL has to be built in. Section 5 of the design also says Support "needs the repo public to be useful".

**Recommended:** the owner supplies the URL. It goes into the desktop build as a constant passed to the server, and the release build script **refuses to build a release** while it is still the placeholder. Development builds may keep the placeholder.

### D6. Application identity: name, appId, icon, shortcuts

- **Product name:** "Coin Inventory". This fixes the default install folder, the Start Menu entry and the window title. Recommended as is.
- **appId** (the Windows AppUserModelID; electron-builder also derives the uninstall registry key from it): **it must never change after the first release**, or upgrades install side by side instead of in place. Recommended: `io.github.<owner-github-name>.coin-inventory`. The owner supplies `<owner-github-name>`.
- **Icon:** the installer and the window need a multi-size `.ico` with a 256x256 layer. The only icon in the repo is `public/favicon.ico`. The owner picks the artwork: the favicon, `public/CACGreenBean-trimmed.png`, or something new. Default: the favicon artwork, upscaled, until something better exists.
- **Shortcuts:** recommended Start Menu **and** desktop shortcut. The target user does not want to hunt for the program.

### D7. What clicking an original photo's path does

Today the link opens `/api/images/file?path=...` in a new browser tab (`coin-image-path-link.html`).

| Option | Trade-offs |
|---|---|
| **A. A new app window showing the original**, so it behaves the same as today | No new behaviour. Stays inside the app. |
| B. Open the file in Windows' default viewer (`shell.openPath`) | Native zoom and editing. Leaves the app. Also needs a new bridge call and a check that the path really is one of the coin's stored paths. |

**Recommended: A for v1.**

### D8. Printing and "Save as PDF"

`print-window.ts` relies on `window.print()` and says the print dialog's "Save as PDF" makes a separate PDF library unnecessary. Inside Electron, `window.print()` may show the **Windows system print dialog** rather than Chrome's preview, which is to be confirmed in Task 0.1. If so, PDF output comes from the "Microsoft Print to PDF" printer that ships with Windows 10 and 11.

**Recommended:** if Task 0.1 shows the system dialog, accept it for v1 and say so in the Help text ("choose Microsoft Print to PDF"). If the owner wants a one-click "Save as PDF", that is a small later task using `webContents.printToPDF` plus a save dialog. It is not in the v1 task list.

### D9. Should the development setup and the installed app share one collection file?

Under D1-A, today's `npm start` and the installed app both resolve `%LOCALAPPDATA%\CoinInventory\coin-inventory.db`. That is convenient (the owner sees his real collection either way) but has a cost. Two processes on one SQLite file is safe for ordinary reads and writes (WAL plus the 5-second busy timeout), and **not** safe for Restore, which closes and renames the file under the other process.

**Recommended:** share it, as today, and document "do not run the development copy and the installed app at the same time". Anyone who wants a separate development collection sets `COIN_INVENTORY_DATA_DIR` in `server/.env`, which already works.

### D10. Browser-era preferences do not carry over

UI preferences (columns, sort, filters, grouping, **and `AppSettings`**, which holds the image storage mode, the import base folder and the maximum image size) live in **IndexedDB, which belongs to one origin** (`src/app/services/storage.service.ts`). The installed app has a new origin, so the owner's installed copy starts with default preferences. His coins, photos and spot prices are in SQLite and are unaffected.

**Recommended:** accept it and say so in the release notes ("check Settings once after installing"). Building a preference export/import for one user is not worth it.

### D11. Deleting the SQL Server tooling

`msnodesqlv8` in the **root** `package.json` has no consumer: nothing under `src/` imports it, and the only SQL Server code is in `server/`. It can go now, and Task 1.8 removes it. `mssql` and `msnodesqlv8` in **`server/package.json`** are kept on purpose until the owner confirms the Stage 2 migration has run (`db/driver-isolation.spec.ts` enforces that they stay). The 2026-11-14 note that the owner "will delete his database and redo his imports" suggests Stage 2 may now be moot.

**Owner to confirm:** has Stage 2 run, or is it abandoned? Until then, keep the server pair. Either way it never reaches the installer (section 5.3 bundles only what the server imports).

### D12. Opening a collection saved by a newer version

Once there is an installer, someone can install an older build over a newer one, or restore a database saved by a newer build onto an older install. Today `db/pool.ts` **deliberately** logs a warning and opens the file anyway.

| Option | Trade-offs |
|---|---|
| **A. Keep opening the file, and also show the user a non-blocking notice** | Keeps the existing deliberate choice: the user still has a working app. The only change is that the user is now told. |
| B. Refuse to open the file | Safest for the data. Leaves the user with an app that will not open their collection until they install a newer version. Reverses a recorded decision. |

**Recommended: A** (Task 1.9).

### Not a decision, but the owner should know: a deviation from the design's sketch

Design section 4.2 sketches the Express server running *inside Electron's main process*. That sketch is the author's call (section 4.2 and section 6, "left to the builder"), and this plan **recommends a separate `utilityProcess` instead**. Section 4.1 gives the reasons. The visible result is the same: one window, no console, no port anywhere.

---

## 2. Where the design stands today

| Design item | State |
|---|---|
| Section 4.1 SQL Server to SQLite | **Done.** `server/db/` runs on `node:sqlite`. `db/driver.ts` is the only file that names it. |
| Section 4.1 Stage 2 one-time migration | Built (`server/migrate-sqlserver/`). Whether it has been run against live data is unknown (D11). |
| Section 4.3 driver choice | **Resolved: `node:sqlite`**, behind one adapter. Inside Electron it still needs Task 0.1. |
| Section 4.4 referenced images, missing-image handling | Done (`routes/images/exists.ts`, the three-state path link). |
| Section 4.4 "my photos moved" repair tool | **Not built.** Out of scope here. |
| Section 4.5 Excel import | **Built** (`read-excel-file`, shared with the CSV path). |
| Section 4.6 Support via GitHub deep link | **Built** (`routes/support/`, `services/support/issue-url.ts`). Needs D5 for a real repo. |
| Section 4.7 / dealer section 16 backup and restore | **Built** (`server/backup/`, `routes/backup/`) using the `node:sqlite` backup API and `PRAGMA user_version`. |
| Section 4.8 user-entered spot prices | Built as far as can be seen (`POST /api/spot-prices`). Not re-audited here. |
| Section 4.9 ImageData base64 to BLOB | **Not done.** `db/schema.sql` still declares `ImageData TEXT`. Not this plan's job. |
| Section 4.9a storing original images in the database | Partly built (image storage modes exist). Not this plan's job. |
| **Section 4.10 per-launch token, Origin check, drop blanket CORS** | **Not built.** `server.ts` still calls `app.use(cors())` and has no token. **In scope here (Task 1.4).** |
| Section 4.10a install layout | Not built. In scope (D1, D3). |
| Section 4.11 unsigned installer, SmartScreen guidance in README | Not built. In scope. |
| Section 7 the build | Works. Note that **`angular.json` now uses `@angular/build:application`**. Section 7 of the design said not to move to it because of the esbuild block, but that was later done safely through `esbuild-wasm` and `scripts/ng-wasm-safe.mjs` (see that file's header and README "Build for production"). |
| Cross-platform item 1 (`userData`) | Not done. In scope (D1, Task 1.5, Task 3.2). |
| Cross-platform item 2 (`'\\'` SEPARATOR) | Not done. In scope (Task 2.2). There is a **second** hardcoded separator in `src/app/services/backup/picked-folder.ts:45`. |
| Cross-platform item 3 (reviewed, unused mac target) | Not done. In scope (Task 4.1). |

The root `README.md` is badly out of date: SQL Server prerequisites, `mssql-mock`, `migrations/` "applied in order". Task 6.1 rewrites the parts this work touches and adds the end-user install section that section 4.11 requires.

---

## 3. What reading the code turned up

These shape the plan. Several are bugs that do not show up today only because nobody runs the compiled server.

1. **The compiled server cannot start.** `server/tsconfig.json` emits `.js` only. `db/schema.ts` reads `path.join(__dirname, 'schema.sql')` and `db/seed.ts` reads `__dirname/../migrations/seed-data/issuers-denominations.json`. Neither file is copied into `server/dist/`, and the existing `server/dist/` has no `.sql` or `.json` in it. So `npm --prefix server start` fails the first time it opens a database. Everything works today only because development runs `tsx` against the source tree.
2. **`angularDistPath` is wrong when compiled.** `server.ts` computes `path.resolve(__dirname, '..', 'dist', 'coin-inventory-app', 'browser')`. Under `tsx` (`__dirname` = `server/`) that is correct. Compiled (`__dirname` = `server/dist/`) it points at `server/dist/coin-inventory-app/browser`, which does not exist. `server/dist-path.spec.ts` checks only the `tsx` layout.
3. **The server listens on every network interface.** `app.listen(PORT)` has no host argument. In a packaged app that is exactly what triggers the Windows Firewall prompt (an anti-goal). It must listen on `127.0.0.1`.
4. **Blanket `cors()` and no access control** (section 4.10). `GET /api/images/file` reads any image-extension file on the machine, and `GET /api/backup/files` lists any folder.
5. **Every UI preference is in IndexedDB, which belongs to one origin.** A random port on each launch gives a **new origin on each launch, so the app would forget every setting every time it starts.** This rules out "load `http://127.0.0.1:<random port>` in the window" and is the main reason for the custom protocol in section 4.3.
6. **The log directory defaults to `server/logs` next to the code.** In a packaged app that is inside the read-only install directory. `COIN_LOG_DIR` must be set.
7. **`import 'dotenv/config'` reads `.env` from the current working directory.** A stray `.env` in whatever folder the app was started from would be loaded. The desktop entry must not load dotenv.
8. **`GET /api/app-info` finds the "install folder" by walking up to `angular.json`**, which does not exist in a packaged app. It would fall through to `process.cwd()` and log a warning on every import screen.
9. **The Desktop path and the app version are worked out inside the server.** `support/report-file.ts:resolveDesktopDirectory` (used by Support *and* by `routes/backup/index.ts` for the backup suggestion) and `routes/support/index.ts:readVersion` (walks to a `package.json`). Electron's `app.getPath('desktop')` handles OneDrive Known Folder Move properly, and `app.getVersion()` is the truth inside the shell.
10. **`window.prompt` is used** in `CategoryModal.renameCatalog` (`src/app/components/category-modal/category-modal.ts:1396`). **Electron does not implement `window.prompt`**, so catalogue rename would silently do nothing. `window.confirm` works in Electron.
11. **The production `index.html` contains an inline `<script>`.** It is the critical-CSS ("beasties") loader, which flips `styles-*.css` from `media="print"` to `all`. A strict CSP (`script-src 'self'`) blocks it, so the global stylesheet would never apply. Fix it at build level (Task 2.8).
12. **`resolveApiBaseUrl()` already does the right thing** (`src/app/services/http-utils.ts`): same origin unless the page is on port 4200. A custom-protocol origin (`app://coin-inventory`) is a real origin, so it needs **no change**.
13. **The "photo viewer window" is not a window.** `src/app/features/inventory/photo-viewer-window.ts` only does the size arithmetic for an in-app overlay. It needs no Electron work. The windows that are real are the print window (`window.open('')`), the original-file link (`target="_blank"`) and the GitHub issue (`window.open(url, '_blank', 'noopener')` plus two `<a target="_blank">` in `support-modal.html`).
14. **Downloads** (CSV and JSON export) use a blob URL and `anchor.click()` (`inventory-file-io.ts`, `csv.service.ts`). Electron shows a Save dialog for downloads by default. Verify this in Task 0.1. No code change is expected.
15. **The root `msnodesqlv8` is dead weight**, and so are the Angular packages, as far as an installer is concerned. They are in root `dependencies`, which electron-builder would try to pack into the app (a *native* module, built for the wrong Node ABI). Section 5 avoids this by packing a staged folder with no dependencies.
16. **The window title** is `CoinInventoryApp` (`src/index.html`). Electron shows the page title in the title bar.

---

## 4. Architecture

### 4.1 Where the server runs: `utilityProcess`, not the main process

**Recommended: run the Express server in an Electron `utilityProcess` child.** The main process owns the window, the protocol handler and IPC. The child owns Express and SQLite.

The reasons, roughly in order of weight:

- **`node:sqlite` is synchronous** (`DatabaseSync`). Every query blocks the thread it runs on. In the main process, a slow query, a large restore inspection, or seeding a fresh database would freeze the window frame, menus, dialogs and the protocol handler. Every request the renderer makes passes through that handler, so one slow query would freeze the whole app. Photo-heavy coins and multi-gigabyte databases (section 4.9a) make slow queries realistic. In a child process a slow query delays only its own response.
- **`process-safety.ts` installs process-wide `uncaughtException` / `unhandledRejection` handlers** that log and *keep running*. That is right for the server and wrong for Electron's main process, where it would hide real shell failures.
- **Crash isolation.** If the server dies, the main process can restart it once and, failing that, show a plain-language message (section 4.6), instead of the whole app vanishing.
- **No console window.** A `utilityProcess` is a Chromium child process. It opens no console on Windows, unlike `child_process.fork(process.execPath)` with `ELECTRON_RUN_AS_NODE`, which this plan also needs disabled for security (section 8.6).

The costs are real and bounded: a separate entry file for the server, a "ready" handshake, and restart logic. The design (section 6) explicitly leaves this to the builder.

**Fallback.** If Task 0.1 shows `node:sqlite` is unavailable in a `utilityProcess` but available in main, run the server in-process with the same `startServer()` function (Task 1.3) and accept the freezing risk for v1. If it is unavailable in both, the fallback is the one `db/driver.ts` was designed for: swap that one file to `better-sqlite3` and add `@electron/rebuild` to the desktop build.

### 4.2 Port handling: random port, loopback only, never shown

- The server listens on **`127.0.0.1` port `0`**, so the OS picks a free port. This removes "port 3000 already in use" as a failure. Binding to loopback means **no firewall prompt**: Windows prompts only when an application listens on an interface reachable from the network.
- The child reports its port to the main process over `process.parentPort.postMessage({ type: 'ready', port })`. The port exists only in the main process's memory. **The renderer never sees it** (see 4.3), so it cannot appear in an error message, a URL bar (there is none) or a support report.
- Bind to the literal `127.0.0.1`, not `localhost`. `localhost` can resolve to `::1` first and does not match the address the forwarder connects to.
- Today's `npm start` keeps port 3000 and its current bind. The owner may be reaching the host from another PC (support plan item 6 suggests so), so the development default is not changed. Only the desktop entry passes `127.0.0.1`.

### 4.3 How the Angular app finds the API: a custom `app://` origin

**Recommended: register a privileged custom scheme and load the app from `app://coin-inventory/`.**

```
renderer  --app://coin-inventory/api/coins-->  main: protocol.handle('app')
                                                 | adds X-Coin-Inventory-Token
                                                 v
                                           http://127.0.0.1:<port>/api/coins  (utilityProcess: Express)
```

- `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }])` runs **before** `app.whenReady()`. `standard` + `secure` give a real, stable origin, which is what IndexedDB needs (finding 5). `stream` lets 46 MB originals and multi-file uploads stream instead of buffering.
- `protocol.handle('app', handler)` forwards **every** request (static files, the SPA fallback, `/api/*`) to the Express server unchanged. Express already serves the built Angular bundle and the SPA fallback (`server.ts`), so **there is one server and one routing table, the same as `npm start`.** Use Node's global `fetch` (undici) in the main process for the forward, not `net.fetch`. Node's `fetch` ignores the system proxy or PAC configuration, which on a managed PC could otherwise touch a loopback request. Pass the body through with `duplex: 'half'` and return `new Response(upstream.body, { status, headers })`.
- The handler **adds the per-launch token header** (section 4.4). The renderer never holds the token. This is stronger than section 4.10's "handed to the renderer", and has the same effect: every `/api` call carries it, including `<img src>` thumbnails and the `<a href>` original-file link, which could not carry a custom header otherwise.
- `resolveApiBaseUrl()` returns `window.location.origin` = `app://coin-inventory`, unchanged (finding 12).
- **The scheme and host (`app`, `coin-inventory`) must never change after release.** They are the IndexedDB origin, and changing them wipes every user's preferences, as D10 describes.

Rejected alternatives:

- Loading `http://127.0.0.1:<random>` directly: a new origin on every launch loses the preferences (finding 5).
- A fixed port: brings back port collisions.
- Persisting "last port used": the origin still changes whenever that port is taken.
- Calling Express in-process from `protocol.handle` without TCP: possible, but only with the server in the main process, which 4.1 rejects.

Things Task 0.1 must confirm for `app://`: Angular's `HttpClient` (XHR by default) works against it. If XHR fails, switch to `provideHttpClient(withFetch())` in `src/app/app.config.ts`. ES-module `<script type="module">` loads. IndexedDB survives a restart. A multi-megabyte POST body streams through.

### 4.4 Access control on the API (design section 4.10)

Express accepts requests only when it can tell they came through the shell, **and only when the shell turned the check on**. Today's browser workflow is untouched.

- At startup the main process generates `crypto.randomBytes(32).toString('base64url')` and passes it to the child as `COIN_INVENTORY_API_TOKEN`.
- When that variable is set, a new middleware (`server/access-control.ts`, mounted before `express.static`) does three things:
  1. Rejects any request whose `X-Coin-Inventory-Token` does not match (compare with `crypto.timingSafeEqual`) with 403 and no body detail.
  2. Rejects any request that carries an `Origin` header. The forwarder sends none, and a hostile web page attacking `127.0.0.1` always does.
  3. Rejects a `Host` other than `127.0.0.1:<port>`, as a DNS-rebinding guard.
- When it is set, `cors()` is **not** mounted. When it is not set (development), behaviour is exactly as today.
- The token covers static files too, so another local process cannot even fetch the bundle. This costs nothing because the shell adds the header to everything.

### 4.5 Startup and shutdown sequence (main process)

1. `app.requestSingleInstanceLock()`. If another copy is running, focus its window and quit. Two copies would mean two servers on one database.
2. Resolve the data folder (section 6) and call `app.setPath('userData', ...)` and `app.setPath('sessionData', ...)` before `ready`.
3. `registerSchemesAsPrivileged`.
4. On `ready`: start the logger for the main process, generate the token, and `utilityProcess.fork(serverEntry, [], { env, serviceName: 'Coin Inventory Server', stdio: 'pipe' })`.
5. Wait for `{ type: 'ready', port }`, with a 20-second timeout. **Do not wait for the database.** If the database cannot open, the app's own status bar and banner ("Cannot connect to database", Retry) already handle it, and the window should still open.
6. Install `protocol.handle`, the session guards (section 8) and the permission handler. Create the `BrowserWindow` with `show: false`, load `app://coin-inventory/`, and show it on `ready-to-show`.
7. On `before-quit`: send `{ type: 'shutdown' }`. The child closes the HTTP server, calls `resetPool()` so the database handle closes and WAL checkpoints cleanly, and exits. Kill it after 5 seconds if it has not.

### 4.6 When the server fails

- The child exits unexpectedly: log it, restart **once**, and reload the window.
- It fails a second time, or never becomes ready: `dialog.showMessageBox` with plain words, for example "Coin Inventory could not start its data service. Your collection has not been changed. Please restart Coin Inventory; if this keeps happening use Help > Report a problem, or send the file `main.log` from <logs folder>." **Never mention a port, a server, `127.0.0.1` or a stack trace** (anti-goal).
- The child's `stdout`/`stderr` are piped into the main log, so a crash before the server's logger starts is still recorded.

---

## 5. Repo layout and build pipeline

### 5.1 Layout

A new top-level `desktop/` package, the same pattern as `server/`. Electron and electron-builder stay out of the root install, which keeps the root `npm install` light on the laptop, and the Angular dependencies stay out of anything electron-builder packs.

```
desktop/
  package.json               electron (exact pin), electron-builder, esbuild, vitest, @playwright/test, typescript
  tsconfig.json
  vitest.config.mts
  electron-builder.config.cjs
  build/                     icon.ico, icon.icns (for the unused mac target), installer assets
  src/
    main.ts                  wiring only: the sequence in section 4.5
    preload.ts               the contextBridge surface (section 8.3)
    data-paths.ts            pure: where data, logs and Electron storage live   (tested)
    server-env.ts            pure: the env handed to the child                  (tested)
    protocol-forward.ts      pure-ish: app:// request to loopback request       (tested)
    navigation-policy.ts     pure: allow, deny or open-externally per URL       (tested)
    csp.ts                   pure: the CSP header string                        (tested)
    ipc-handlers.ts          dialogs, path lookups; validates the sender        (tested with fakes)
    server-supervisor.ts     fork, ready, restart-once, shutdown                (tested with a fake fork)
    main-log.ts              a small rotating log for the main process
  scripts/
    stage.mjs                assembles desktop/stage/ (section 5.3)
  e2e/
    smoke.spec.ts            Playwright _electron smoke test (section 10.2)
  stage/                     GENERATED, git-ignored
  release/                   GENERATED, git-ignored: installers and win-unpacked/
```

The server gets one new entry file, `server/desktop-entry.ts`, which runs inside the `utilityProcess`, plus the small modules from Tasks 1.1 to 1.7. The front end gets `src/app/services/desktop/` (the typed bridge and its detection).

### 5.2 Build-time constraints that carry over

- **`esbuild-wasm`, `sass` 1.101.0 and `sass-embedded`→`sass` stay** as they are (dealer-readiness section 17: they exist for the laptop and are removed "the day builds move off this laptop", which is not this work). `desktop/package.json` gets the same `"esbuild": "npm:esbuild-wasm@..."` override as `server/package.json`, so staging also works on the laptop.
- **Keep calling the Angular CLI through `scripts/ng-wasm-safe.mjs`** (`npm run build`). Calling `ng build` directly fails on the laptop.
- **Pin Electron exactly** (`"electron": "45.3.4"`, no caret) and move one major at a time, following the section 17 rule. `node:sqlite`'s availability is tied to Electron's Node, which changes with every Electron major (46 moves to Node 26).
- The design says the git repo is on an `I:\` network share and builds run from `C:\...\source\dev`. Every script resolves paths relative to its own file (`import.meta.url` / `__dirname`), never relative to the repo root or the current directory.

### 5.3 From sources to installer

```
npm run build                         -> dist/coin-inventory-app/browser/        (Angular, unchanged)
desktop: npm run stage                -> desktop/stage/
    esbuild  server/desktop-entry.ts  -> stage/server/server.js   (bundle; platform node; external node:*)
    copy     server/db/schema.sql     -> stage/server/assets/schema.sql
    copy     server/migrations/seed-data/issuers-denominations.json -> stage/server/assets/
    copy     dist/coin-inventory-app/browser/**  -> stage/renderer/
    esbuild  desktop/src/main.ts      -> stage/main.js
    esbuild  desktop/src/preload.ts   -> stage/preload.js
    write    stage/package.json  { name, productName, version, buildNumber, main: "main.js" }   (no dependencies)
desktop: npm run dist                 -> desktop/release/Coin Inventory Setup 1.0.0.<build>.exe
desktop: npm run dist:dir             -> desktop/release/win-unpacked/   (no installer; fast iteration)
```

Why bundle the server with esbuild instead of shipping `tsc` output plus `node_modules`:

- `server/package.json`'s dependencies include `mssql` and the native `msnodesqlv8` (D11). Shipping its `node_modules` would put a native module built for the wrong Node ABI into the installer. A bundle contains only what `desktop-entry.ts` actually imports. `tsconfig.build.json` already excludes `migrate-sqlserver/`, and the bundle inherits that by never importing it.
- The staged `package.json` has **no dependencies**, so electron-builder packs no `node_modules` at all. That is the simplest thing that can work, and it is easy to audit: list `stage/` and that is the app.
- Express 5 bundles cleanly as long as no view engine is used, and none is. Task 3.7 verifies this by running the staged server under plain Node and calling `/api/health`.

Bundling puts every server module's `__dirname` at `stage/server/`, which breaks the `__dirname`-relative lookups in findings 1, 2, 6, 8 and 9. **Task 1.1 replaces those lookups with one `server/runtime-paths.ts` module** that reads explicit overrides (`COIN_SERVER_ASSETS_DIR`, `COIN_STATIC_DIR`) and otherwise falls back to today's source-tree behaviour. As a side effect this fixes `npm --prefix server start` (findings 1 and 2).

The version comes from one place. `stage.mjs` copies `version` and `buildNumber` out of the root `package.json`, the only file `scripts/bump-build.mjs` writes. electron-builder's `buildVersion` is set to `${version}.${buildNumber}`, which is the Windows file version, so Explorer's Properties dialog shows `1.0.0.N`, the same as the title bar. The installer's file name includes it too. `src/app/version.spec.ts` already pins the front end's copy, and Task 4.1 adds a desktop spec that pins the staged one.

### 5.4 Development workflows

| Command (root `package.json`) | What runs | Use for |
|---|---|---|
| `npm start` | **Unchanged.** `tsx watch` server on :3000 and `ng serve` on :4200, viewed in a browser. | Everyday front-end and server work, on any machine, including the laptop. |
| `npm run desktop:dev` | The same two processes, plus Electron in **dev mode**: the window loads `http://localhost:4200`, there is no `utilityProcess`, no token, and DevTools are allowed. The preload bridge is active. | Front-end work that touches the bridge (pickers, real paths, window-open rules), with hot reload. Host only (D4). |
| `npm run desktop:start` | Production Angular build, staging, then `electron desktop/stage`: `app://`, `utilityProcess`, token, CSP, all exactly as shipped, but not installed. | Shell work, and anything about the server running as a child. Host only. |
| `npm run desktop:dist` / `desktop:dist:dir` | The full installer, or the unpacked app | Releases, the smoke test, VM testing. Host only. |

Dev mode is chosen by an explicit `COIN_INVENTORY_DESKTOP_DEV_URL=http://localhost:4200` environment variable, **never** by `app.isPackaged` alone, so a packaged build can never be pointed at a development URL. The main process ignores that variable when `app.isPackaged` is true.

---

## 6. Data location, first run, upgrades and uninstall

### 6.1 One folder, decided in one place

`desktop/src/data-paths.ts` (pure, tested) works out, in this order:

1. If the user's environment already sets `COIN_INVENTORY_DB_PATH` or `COIN_INVENTORY_DATA_DIR`, honour it and **do not override it**. These are the existing power-user and test overrides (`server/db/config.ts`). The smoke test depends on this.
2. Otherwise, the data root is `%LOCALAPPDATA%\CoinInventory` on Windows (D1-A) and `app.getPath('userData')` elsewhere. If `LOCALAPPDATA` is somehow missing on Windows, fall back to `app.getPath('userData')`.

From that root:

```
%LOCALAPPDATA%\CoinInventory\
  coin-inventory.db (+ -wal, -shm)     the collection                       (server, via COIN_INVENTORY_DATA_DIR)
  logs\app-YYYY-MM-DD.log              server log, rotated as today         (COIN_LOG_DIR)
  logs\main.log                        main-process log                     (desktop/main-log.ts)
  shell\                               Electron's own storage: IndexedDB, caches (app.setPath('sessionData'))
```

Electron's `userData` is set to the root and `sessionData` to `shell\`, so Chromium's cache folders do not clutter the folder a user may be told to back up. **Back up the whole folder** is then a true statement.

`server-env.ts` builds the child's environment: `COIN_INVENTORY_DATA_DIR`, `COIN_LOG_DIR`, `COIN_SERVER_ASSETS_DIR`, `COIN_STATIC_DIR`, `COIN_INVENTORY_API_TOKEN`, `COIN_DESKTOP_DIR=app.getPath('desktop')`, `COIN_APP_VERSION`, `SUPPORT_REPO_URL` (D5), `APP_BASE_FOLDER` (section 7.1), and `COIN_INVENTORY_DESKTOP=1`, which switches off dotenv (finding 7). The server's `db/config.ts` keeps its `LOCALAPPDATA` fallback **only** for the browser workflow. In the desktop app it is always told.

### 6.2 First run

There is no setup step. `db/pool.ts` already creates the folder, applies `schema.sql` and seeds the reference data on first open. The first window shows an empty collection. Nothing else is needed. Do not add a first-run wizard; it would be "something auxiliary to think about".

### 6.3 An existing database

Under D1-A, an existing `%LOCALAPPDATA%\CoinInventory\coin-inventory.db` (the owner's) is simply opened, with no migration. Under D1-B, the main process, on a first run where the new location has no database and the old one exists, **copies** it using the server's existing backup machinery, never a raw file copy because of the WAL trap in design section 4.7. It leaves the original in place and logs both paths. Write that only if the owner picks B.

**Schema version guard (related risk, section 12).** There is no migration runner yet (`db/schema.ts`). `db/pool.ts` already detects a database stamped with a *newer* `user_version` and, **deliberately**, only logs a warning and carries on ("refusing to open would leave the user with no app"). An installer makes downgrades possible for the first time, so D12 asks whether the user should also be told. The default does not reverse the existing choice.

### 6.4 Upgrade in place

NSIS with a fixed `appId` (D6) uninstalls the previous version's files and installs the new ones into the same folder. Data is not in that folder, so it survives by construction (design section 4.10a). The release checklist (section 10.3) proves this with real data rather than assuming it.

### 6.5 Uninstall never deletes data

- The uninstaller removes the install folder, the shortcuts and the registry entries. It must not touch `%LOCALAPPDATA%\CoinInventory`.
- electron-builder's `deleteAppDataOnUninstall` stays `false` (the default; it only applies to one-click installers anyway). There must be **no** custom NSIS `customUnInstall` macro that removes data.
- Design section 6 allows the uninstaller to *offer* removing data, but "must not do so silently". v1 does not offer it, which is the safe reading. If it is ever added, it must default to keep.

### 6.6 Backups and where files are suggested

The backup suggestion and the support report go to `COIN_DESKTOP_DIR` when it is set (Task 1.5), and otherwise to today's `resolveDesktopDirectory()`. Settings should show the data folder's full path with an "Open folder" button (SQLite plan, "Backup/restore: CUT", item 1, still worth doing). In the desktop app the button calls `shell.openPath(dataRoot)` through the bridge. The browser keeps showing the path as text.

---

## 7. Browser-only features: what each becomes

### 7.1 Batch image import (folder picking and source paths)

- Keep the `<input type="file" webkitdirectory>` element. In Electron it opens the native folder dialog and returns `File` objects as today.
- **Real paths (D2-A).** The preload exposes `getPathForFile(file): string`, which wraps `webUtils.getPathForFile`. In `source-path.ts`, `sourcePathForFile()` gains a desktop branch: if the bridge returns a non-empty absolute path, use it as is. Otherwise fall back to today's join. The base folder is filled automatically after a pick by taking the first file's real path and removing its `webkitRelativePath` tail. The guard (`base-folder-check.ts`) and the preview run unchanged, and now always pass.
- Interaction with the existing design: `CoinImages.SourcePath` keeps meaning "a path valid on the machine running the server". In the desktop app that is the same machine as the picker by construction. Comparison (`normalizeSourcePathForComparison`) is unchanged, so photos already imported through the browser with a correct base folder dedupe against real paths, because both are `D:\...` forms. **A mapped drive can break that.** A file picked through a mapped drive letter returns that letter. If the browser-era rows were typed as UNC (`\\NAS\...`), they will not match, and a re-import attaches duplicates. Test this in Task 2.3 with real rows, and mention it in the release notes if it happens.
- `APP_BASE_FOLDER`: the desktop app sets it to the install folder (`path.dirname(app.getPath('exe'))`), which preserves today's prefill when nothing has been picked yet and fixes finding 8.
- **The SEPARATOR fix (cross-platform item 2).** Replace the constant `'\\'` in `source-path.ts:69` with a separator taken from the base folder itself: backslash if it has a drive letter, a UNC prefix or any backslash; forward slash if it starts with `/`. Split on `/[\\/]/`, as `image-file-filter.ts` already does. Apply the same fix to `picked-folder.ts:45`. Existing Windows behaviour must not change: every current `source-path` spec must pass unedited.
- A new design (`2026-11-18-image-import-photo-sets-design.md`) is touching the same import screen. Coordinate with it to avoid merge conflicts in `image-import-modal.*` and `batch-import-session.ts`.

### 7.2 Backup and restore folder and file boxes

In the desktop app, "Choose folder..." and "Choose file..." call `pickFolder()` / `pickBackupFile()` through the bridge, which wraps `dialog.showOpenDialog` with `openDirectory` or `openFile` and a `*.db` filter. The real path goes into the same box the guess goes into today, and the server listing (`GET /api/backup/files`) still validates it. `picked-folder.ts`'s guess, and its sentence explaining the guess, are used only in the browser. The desktop UI must not show "Your browser told us only the folder's NAME".

### 7.3 Original photo files (the source-path click-through)

The `<a href=".../api/images/file?path=..." target="_blank">` stays. `setWindowOpenHandler` (section 8.4) sees an `app://coin-inventory/api/images/file?...` URL and opens it in a new, plain, sandboxed `BrowserWindow` with no preload, sized to half the screen (D7-A). The protocol handler adds the token, so the stream works exactly as in a browser tab.

### 7.4 The in-app photo viewer

`photo-viewer-window.ts` is an overlay inside the app window, not a separate window (finding 13). It needs no change. Spot-check it in the smoke checklist.

### 7.5 Printing and reports

`print-window.ts` calls `window.open('', '_blank', 'width=1000,height=800')`, writes HTML into it and calls `print()`. The window-open handler must **allow `about:blank`** and give it `overrideBrowserWindowOptions` with no preload, `sandbox: true` and `show: true`. The new window inherits the opener's CSP. The report uses one inline `<style>`, which `style-src 'unsafe-inline'` allows, and images are `data:` or `app:` URLs, which are allowed. Printing behaviour itself is D8.

### 7.6 Downloads (CSV and JSON export)

Blob URL plus `anchor.click()`. Electron's default is a Save As dialog. Confirm this in Task 0.1. If it is not the default, add a `session.on('will-download')` handler that calls `item.setSaveDialogOptions({ defaultPath: <Desktop>/<suggested name> })`.

### 7.7 External links and the Support / GitHub flow

- `support.service.ts` uses `window.open(url, '_blank', 'noopener')`, and `support-modal.html` has two `<a target="_blank">` links to the issue page. The window-open handler sends **`https:` URLs to `shell.openExternal`** (the user's real browser, as design section 4.6 intends: the user signs in and presses Submit there) and denies the in-app window.
- Allow only `https:` for `openExternal`, never `file:`, `javascript:` or custom schemes. Log the host.
- The clipboard fallback (`navigator.clipboard.writeText`) needs the `clipboard-sanitized-write` permission. That is the one permission the permission handler grants (section 8.5).
- The report `.md` and log `.txt` still go to the Desktop (`COIN_DESKTOP_DIR`), and the dialog already names their full paths. Optional nicety for later: a "Show in folder" button using `shell.showItemInFolder`.

### 7.8 `window.prompt` (catalogue rename)

Replace it with a small in-app rename dialog, or an inline edit like the issuer edit in dealer-readiness item 11a. Use it in both the browser and the desktop app, so there is one code path. Keep the existing rule: a blank, unchanged or cancelled name saves nothing.

### 7.9 Words on screen that assume a browser or a server

Anti-goal: "an error that mentions a port number" and a visible server. Sweep the user-visible strings. Search for: `browser`, `server`, `backend`, `host`, `localhost`, `port`, `tab`. Known cases are `describeHttpError`'s "Network error — the backend server did not respond", the image-import hint "the machine hosting the app, not your browser", and `picked-folder.ts`'s sentence. In the desktop app, show wording that does not mention any of them (for example, "Coin Inventory lost contact with its data. Try again, or restart the app."). Logs can stay technical, and the browser workflow keeps its current wording. Have the owner review the replacement wording before release.

---

## 8. Security hardening

### 8.1 `BrowserWindow` web preferences

```
contextIsolation: true     (default; state it anyway)
sandbox: true              (default since Electron 20; state it anyway)
nodeIntegration: false
nodeIntegrationInWorker: false
webSecurity: true
allowRunningInsecureContent: false
spellcheck: false          (sends nothing; avoids downloading dictionaries)
devTools: !app.isPackaged
preload: <stage>/preload.js
```

No `webviewTag`, no `remote`, no `enableBlinkFeatures`.

### 8.2 Content Security Policy

`csp.ts` produces this, and the protocol handler adds it as a response header on every HTML response:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self';
font-src 'self' data:;
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

- `'unsafe-inline'` for styles is required: Angular's emulated encapsulation injects `<style>` tags, and the print report uses an inline stylesheet.
- `data:` is for the stored base64 photos. `blob:` is for `thumbnail-cache.ts`'s object URLs.
- `connect-src 'self'` holds because the only outbound calls (spot prices, the Wikidata lookup) are made by the **server**, not the renderer.
- Finding 11: the beasties inline `<script>` would be blocked. Task 2.8 turns off critical-CSS inlining (`"optimization": { "styles": { "inlineCritical": false } }` in the production configuration of `angular.json`). That is simpler than hashing the script, and inlining critical CSS buys nothing for an app loaded from local disk.
- Dev mode (`desktop:dev`) sets no CSP. It is not shipped.

### 8.3 Preload surface (the whole bridge)

```ts
window.coinInventoryDesktop = {
  isDesktop: true,
  platform: 'win32' | 'darwin' | 'linux',
  getPathForFile(file: File): string,                   // webUtils.getPathForFile, in the preload, no IPC
  pickFolder(defaultPath?: string): Promise<string | null>,
  pickBackupFile(defaultPath?: string): Promise<string | null>,
  openDataFolder(): Promise<void>,                      // shell.openPath(dataRoot), fixed path, no argument
}
```

- Expose functions only, through `contextBridge.exposeInMainWorld`. **Never expose `ipcRenderer` itself**, and do not expose a generic "invoke any channel" function.
- Every `ipcMain.handle` checks `event.senderFrame.url` starts with `app://coin-inventory/` (or the dev URL in dev mode). Arguments are type-checked and length-limited.
- Nothing takes an arbitrary path to open. `openDataFolder` has no parameter. D7-B, if ever chosen, would add a path argument that must be checked against stored `SourcePath` values server-side.
- The front end reads the bridge through one typed module (`src/app/services/desktop/desktop-bridge.ts`) that returns `null` in a browser. Unit tests run under plain Node with no `window`, so that module must tolerate `window` being undefined.

### 8.4 Navigation and new windows

- `will-navigate` and `will-redirect`: allow only `app://coin-inventory/*` (or the dev URL in dev mode). Deny everything else. This also stops a dropped file turning into a `file://` navigation.
- `setWindowOpenHandler`, decided by `navigation-policy.ts` (pure, table-tested):
  - `about:blank` → allow (print window). No preload, sandboxed.
  - `app://coin-inventory/api/images/file?...` → allow (original photo window). No preload, sandboxed, no further window opening.
  - `https:` → `shell.openExternal`, deny the in-app window.
  - anything else → deny and log.
- `webContents.on('will-attach-webview')` → prevent.

### 8.5 Permissions

`session.setPermissionRequestHandler` and `setPermissionCheckHandler`: deny everything except `clipboard-sanitized-write` from the app origin. The app needs no camera, microphone, geolocation, notifications or HID.

### 8.6 Loopback-only server, and Electron fuses

- Section 4.4 covers it: bind to `127.0.0.1`, require the token, refuse `Origin`, check `Host`.
- Flip Electron fuses at package time, using electron-builder's `electronFuses` option if the pinned version supports it, otherwise `@electron/fuses` in an `afterPack` hook:
  - `RunAsNode: false`
  - `EnableNodeOptionsEnvironmentVariable: false`
  - `EnableNodeCliInspectArguments: false`
  - `EnableEmbeddedAsarIntegrityValidation: true`
  - `OnlyLoadAppFromAsar: true`
  - `EnableCookieEncryption: true`

  `utilityProcess` does not need `RunAsNode`. Verify that the app still starts after the fuses are flipped (Task 4.3).

---

## 9. Packaging with electron-builder

`desktop/electron-builder.config.cjs`, in outline:

```js
module.exports = {
  appId: 'io.github.<owner>.coin-inventory',     // D6. NEVER change after first release.
  productName: 'Coin Inventory',
  directories: { app: 'stage', output: 'release', buildResources: 'build' },
  buildVersion: `${version}.${buildNumber}`,      // read from stage/package.json
  asar: true,
  asarUnpack: ['server/**'],                      // see note below
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    // no signing in v1 (design section 4.11): leave certificate settings unset
  },
  nsis: {
    oneClick: false,                              // assisted, so the folder can be chosen
    perMachine: true,                             // D3-A: Program Files, one UAC prompt, no "for whom?" page
    allowToChangeInstallationDirectory: true,     // the one question
    allowElevation: true,
    createDesktopShortcut: true,                  // D6
    createStartMenuShortcut: true,
    shortcutName: 'Coin Inventory',
    runAfterFinish: true,                         // a checkbox on the finish page, not a question
    deleteAppDataOnUninstall: false,              // section 6.5
    artifactName: 'Coin Inventory Setup ${buildVersion}.${ext}',
    // no license page, no installer language picker
  },
  mac: {                                          // reviewed, unused (cross-platform item 3). Never built here.
    target: ['dmg', 'zip'],
    category: 'public.app-category.lifestyle',
    icon: 'build/icon.icns',
    hardenedRuntime: false,                       // unsigned friend build; Gatekeeper right-click > Open
  },
  // electronFuses: { ... }                       // section 8.6
};
```

Notes:

- **"Only asks the install location".** With `oneClick: false` plus a fixed `perMachine`, the pages are: choose folder, install, finish. Add no license file, because a license file adds a page. UAC appears once (D3).
- **`asarUnpack: ['server/**']`.** It is not yet known whether `utilityProcess.fork` can start a script inside `app.asar`, or whether `fs` reads of `assets/schema.sql` work from the child. Unpacking the server folder avoids both questions at negligible size. If Task 0.1 shows asar works from the child, unpacking can be dropped later.
- **File associations:** none in v1. The app opens no document type. Do not associate `.db` (too generic) or `.qif`/`.csv`/`.xlsx` (those belong to Excel and Quicken).
- **Size:** expect a ~90 MB installer and ~250-300 MB installed. Electron 45 is larger than the design's 2026-10 estimate of 150-200 MB. It is still unremarkable, and it can go in the README.
- **Code signing:** none in v1 (design section 4.11). The README section (Task 6.1) is written **after** seeing the real SmartScreen screens on the clean VM: "Windows protected your PC", then **More info**, then **Run anyway**, in the exact words observed.
- **Mac:** the target exists so that a friend can run `npm run desktop:dist -- --mac` on a Mac. Nothing here runs it. Gatekeeper's "cannot be opened because the developer cannot be verified" message and the right-click, then Open workaround belong in a short `desktop/MAC.md` for that friend, written when it happens rather than now.

---

## 10. Testing

### 10.1 What existing suites keep covering

- `npm test` (front end, vitest, Node, no DOM) still covers all app logic. New front-end code follows the project's established pattern: pure functions beside the component, tested in Node (for example the bridge-aware `sourcePathForFile`, the separator choice, the rename dialog's save/ignore rule).
- `npm run test:server` keeps covering every route. The new server pieces are plain Express and Node, testable with supertest as usual: the access-control middleware, `startServer()` binding `127.0.0.1` on port 0, `runtime-paths.ts`, the `COIN_DESKTOP_DIR` / `COIN_APP_VERSION` overrides, dotenv being skipped, and shutdown closing the handle.
- **Safety rule that must hold for every new test:** nothing may resolve the real `%LOCALAPPDATA%\CoinInventory`. The server suite already pins `COIN_INVENTORY_DB_PATH=:memory:` (`test-support/vitest-setup.ts`). The desktop suite and the smoke test must set `COIN_INVENTORY_DATA_DIR` to a fresh temp folder, and the smoke test asserts that folder was actually used.

### 10.2 New tests

- **`desktop/` unit tests (vitest, no Electron).** The pure modules (`data-paths`, `server-env`, `navigation-policy`, `csp`, `protocol-forward`) are tested directly with tables of inputs. `server-supervisor` and `ipc-handlers` are tested with injected fakes for `utilityProcess`, `dialog` and `shell`. Main-process code that imports `electron` directly stays thin wiring in `main.ts` and is covered by the smoke test, not unit tests.
- **Server child under plain Node.** A test, or a stage-script check, that starts `stage/server/server.js` with plain `node` and fake environment variables, waits for `ready`, and calls `/api/health` with and without the token. This catches bundling problems (Express, `__dirname`, missing assets) without Electron, so it can run on the laptop too.
- **Packaged-app smoke test (Playwright `_electron`, host only).** Run it against `desktop/release/win-unpacked/Coin Inventory.exe` (or `electron stage/` for speed), with `COIN_INVENTORY_DATA_DIR` set to a temp folder. It checks:
  1. The window opens and its URL starts with `app://coin-inventory/`.
  2. `/api/health` through the page reports connected.
  3. Adding a coin, closing the app and relaunching shows it, so the database persists.
  4. Changing a column preference, closing and relaunching keeps it, so IndexedDB persists. This is the regression pin for finding 5.
  5. A `fetch` to the loopback port without the token gets 403. The test reads the port from the main log or a test-only IPC hook that exists only when `COIN_INVENTORY_E2E=1`.
  6. `window.open('https://example.com')` does not create an app window.
  7. The temp data folder holds `coin-inventory.db` and `logs\`, and the real `%LOCALAPPDATA%\CoinInventory` was not touched (compare its modification time before and after).

  Playwright's Electron support is marked experimental. If it proves flaky, the same checks go in the manual checklist and the spec stays as documentation.

### 10.3 Manual release checklist (clean Windows 11 VM, no Node, no dev tools)

Run every item on a **fresh VM snapshot**, as design section 7 requires. Record what you saw, not what you expected.

**Install**
- [ ] Download the installer through a browser, so it gets the internet zone mark. Record the exact SmartScreen wording and buttons. Proceed with More info, then Run anyway.
- [ ] Note the UAC prompt (D3). The installer's only question is the folder; the default is `C:\Program Files\Coin Inventory`. Change it once to a custom folder on one run.
- [ ] No other installer, runtime or prompt appears. The finish page offers "Run Coin Inventory".
- [ ] Start Menu and desktop shortcuts exist and have the icon. Explorer, Properties, Details shows file version `1.0.0.N`.

**First run**
- [ ] The window opens titled "Coin Inventory". There is no console window, no tray icon and no firewall prompt.
- [ ] `netstat -ano | findstr LISTENING` shows the app's listener **only** on `127.0.0.1`.
- [ ] Empty collection. `%LOCALAPPDATA%\CoinInventory\coin-inventory.db` and `logs\` were created. Nothing was written into the install folder.
- [ ] Run as a **standard (non-admin) user** after an admin install. The app works and writes data under that user's profile.

**Every feature that touched a browser API**
- [ ] Image import from a folder: real paths are stored (D2), the preview is correct, and clicking a path opens the original in an app window (D7).
- [ ] Re-import the same folder: nothing duplicates.
- [ ] Backup to Desktop. Restore from the native file picker. Pick an empty folder in the folder picker.
- [ ] Print the insurance report. Record which dialog appears and save a PDF (D8).
- [ ] Export CSV: a Save dialog appears.
- [ ] Excel, CSV and QIF import with the sample files in `docs/sample-imports/`.
- [ ] Rename a catalogue (finding 10).
- [ ] Help, then Report a problem: the report and log files land on the Desktop (including when OneDrive manages the Desktop, if possible), and the issue page opens in the **system browser**.
- [ ] Spot price fetch, issuer online lookup, and both with the network disconnected: honest failure, no "server" or "port" wording.
- [ ] Kill the server child in Task Manager (the "Coin Inventory Server" utility process). The app recovers once. Kill it twice: the plain-words dialog appears.

**Upgrade in place**
- [ ] With 20+ coins, photos, a backup and changed preferences, run `bump-build`, build, and install the new setup.exe over the old one. Coins, photos, preferences and the database file's location are unchanged, and the window shows the new build number.

**Uninstall**
- [ ] Uninstall through Settings, then Apps. The install folder and shortcuts are gone. **`%LOCALAPPDATA%\CoinInventory` and everything in it are still there.** Reinstall: the collection reappears.

**Owner's machine (once)**
- [ ] Install on the host with the existing collection in place: it opens his data (D1-A). Re-check Settings (D10).

---

## 11. Sequenced task list

Every task ends with the three existing gates green (`npm test`, `npm run test:server`, `npm run build`) and today's `npm start` working, plus its own check. Tasks marked **[host]** need a machine that can run Electron (D4).

### Phase 0: prove the risky assumptions

**Task 0.1 [host]: Electron capability spike (throwaway, outside the repo).**
In a scratch folder, not this repo, `npm i electron@45.3.4` and write a ~60-line `main.js` that does the following:
- (a) `require('node:sqlite')` in main and inside a `utilityProcess` child, opening a file database and running `PRAGMA journal_mode=WAL` and the `backup()` API.
- (b) Registers `app://` as privileged and forwards to a tiny loopback HTTP server, then confirms: XHR **and** `fetch` work from the page, `<script type="module">` loads, IndexedDB written in one launch is readable in the next, and a 30 MB POST streams through.
- (c) `<input webkitdirectory>` plus `webUtils.getPathForFile` returns absolute paths.
- (d) `window.print()` dialog type, and that `window.open('')` returns a writable window.
- (e) The default download behaviour for a blob anchor.
- (f) What `window.prompt` does.
- (g) Whether a `utilityProcess` script inside an asar archive starts.
- (h) On the laptop: whether `electron.exe` runs at all.

*Output:* a short "Verification log" section appended to **this plan** recording each answer and the Electron version. *Verify:* every row in the table in section 0 that says "Not verified" now has an answer. If (a) fails, stop and apply the fallback in section 4.1 before going further.

**Task 0.2: Record the owner's answers to D1-D12** at the top of this file, and change the recommended defaults where he chose otherwise.

### Phase 1: make the server embeddable (all of it testable without Electron)

**Task 1.1: `server/runtime-paths.ts`.**
One module answers "where is `schema.sql`", "where is the seed JSON" and "where is the Angular bundle". The order is: an explicit environment variable (`COIN_SERVER_ASSETS_DIR`, `COIN_STATIC_DIR`), then a search that works from both `server/` and `server/dist/`. Point `db/schema.ts` (`SCHEMA_PATH`), `db/seed.ts` (`SEED_DATA_PATH`), `migrations/seed-files.ts` and `server.ts` (`angularDistPath`) at it. Do not change `test-support/schema-columns.ts`; tests read the source file on purpose.
*Files:* `server/runtime-paths.ts` (+ spec), `server/db/schema.ts`, `server/db/seed.ts`, `server/migrations/seed-files.ts`, `server/server.ts`, `server/dist-path.spec.ts` (add a case for the compiled layout).
*Verify:* the new spec covers the env override, the `tsx` layout and the compiled layout. `dist-path.spec.ts` still passes.

**Task 1.2: Make `npm --prefix server start` actually work.**
Add `server/scripts/copy-assets.mjs`, run after `tsc` in `server`'s `build` script, which copies `db/schema.sql` and `migrations/seed-data/*.json` into `dist/` at mirrored paths.
*Files:* `server/package.json`, `server/scripts/copy-assets.mjs`, `server/README.md` (stale-dist note).
*Verify:* `npm --prefix server run build`, then `COIN_INVENTORY_DATA_DIR=<temp> PORT=3999 node server/dist/server.js`, then `GET http://localhost:3999/api/health` returns `{"status":"ok","database":"connected"}` and `GET /` returns the app (after `npm run build`).

**Task 1.3: `startServer()` and `server/desktop-entry.ts`.**
Export `startServer({ host, port }): Promise<{ port: number; close(): Promise<void> }>` from `server.ts` (or a new `server/start.ts`). The existing direct-run branch calls it with today's defaults. Do not change today's bind; see section 4.2. `desktop-entry.ts` calls `startServer({ host: '127.0.0.1', port: 0 })`, posts `{ type: 'ready', port }` on `process.parentPort`, and handles `{ type: 'shutdown' }` by calling `close()` then `resetPool()`, then exiting. When `parentPort` is absent, for example under plain Node in a test, it prints the ready message to stdout.
*Files:* `server/server.ts`, `server/desktop-entry.ts` (+ spec), `server/server.spec.ts`.
*Verify:* the spec starts the server on port 0 and asserts the address is `127.0.0.1` and the port is non-zero, then that `close()` releases the port. The `tsx` dev path still listens on 3000.

**Task 1.4: Access control (design section 4.10).**
`server/access-control.ts`: token, Origin and Host checks as in section 4.4, active only when `COIN_INVENTORY_API_TOKEN` is set. When it is set, `cors()` is not mounted. Mount it first, before `express.static`.
*Files:* `server/access-control.ts` (+ spec), `server/server.ts`, `server/README.md` (environment table).
*Verify:* specs for a missing token (403), a wrong token (403), the right token (200), any `Origin` (403), a wrong `Host` (403), an unset variable (today's behaviour, including the CORS header), and a static file also needing the token.

**Task 1.5: Desktop path and version overrides.**
`COIN_DESKTOP_DIR` is read first by a small wrapper around `resolveDesktopDirectory` that both `routes/support/index.ts` and `routes/backup/index.ts` call. `COIN_SUPPORT_OUTPUT_DIR` keeps precedence for tests. `COIN_APP_VERSION` is read first by `readVersion`.
*Files:* `server/support/report-file.ts`, `server/routes/support/index.ts`, `server/routes/backup/index.ts`, their specs, `server/README.md`.
*Verify:* specs for each override. The existing OneDrive cases are unchanged.

**Task 1.6: Desktop mode switches off dotenv.**
Replace `import 'dotenv/config'` with a conditional load that is skipped when `COIN_INVENTORY_DESKTOP=1`. Keep the load at the top of the module, before anything reads `process.env`.
*Files:* `server/server.ts` (or `server/load-env.ts` + spec).
*Verify:* a spec with a temporary `.env` in the cwd shows it is loaded normally and ignored in desktop mode.

**Task 1.7: `app-info` honours the shell.**
No code change is expected: `APP_BASE_FOLDER` already overrides it. Add a spec that pins "with `APP_BASE_FOLDER` set, no filesystem walk and no warning is logged".
*Files:* `server/routes/app-info.spec.ts`.

**Task 1.8: Remove the root `msnodesqlv8`.**
*Files:* `package.json`, `package-lock.json` (by `npm uninstall msnodesqlv8` at the root only).
*Verify:* `npm ls msnodesqlv8` at the root shows nothing. `server/package.json` still declares it, and `db/driver-isolation.spec.ts` stays green. The three gates pass.

**Task 1.9: Make the "newer database" warning visible (D12-A).**
`db/pool.ts` already detects `user_version > SCHEMA_VERSION` and logs a warning. Keep opening the file, as today. Add `schemaNewerThanBuild: true` to the `GET /api/health` body and show a non-blocking notice in the app: "This collection was last saved by a newer version of Coin Inventory. Install the latest version to be sure everything displays correctly." Keep the existing health keys and values unchanged, because `start-coin-inventory.ps1` parses them. If the owner chooses D12-B (refuse), turn this into a typed refusal instead, worded in the style of `backup/verdict.ts`.
*Files:* `server/db/pool.ts`, `server/routes/health.ts`, `server/server.spec.ts`, `src/app/services/inventory/connection-manager.ts`, specs.
*Verify:* a spec opens a file stamped `user_version = SCHEMA_VERSION + 1`: health still reports connected, now with the flag, and the file is not re-stamped.

### Phase 2: make the front end shell-aware (the browser stays identical)

**Task 2.1: The typed desktop bridge.**
`src/app/services/desktop/desktop-bridge.ts` exports `desktopBridge(): DesktopBridge | null`. It returns `null` when `window` or `window.coinInventoryDesktop` is absent, and the interface is the one in section 8.3. Nothing else in `src/` touches `window.coinInventoryDesktop`.
*Files:* `src/app/services/desktop/desktop-bridge.ts` (+ spec), `src/app/types/desktop-bridge.d.ts` (or inline).
*Verify:* specs for no `window`, a `window` without the bridge, and a fake bridge.

**Task 2.2: The SEPARATOR fix (cross-platform item 2).**
Derive the separator from the base folder as described in section 7.1. This covers `source-path.ts` and `backup/picked-folder.ts`.
*Files:* `src/app/services/image-import/source-path.ts` (+ spec), `src/app/services/backup/picked-folder.ts` (+ spec).
*Verify:* **every existing spec passes unedited**, plus new POSIX cases (`/Users/x/Pictures` + `a/b.jpg` → `/Users/x/Pictures/a/b.jpg`, and the doubled-name rule with forward slashes).

**Task 2.3: Real paths in image import (D2-A).**
`sourcePathForFile` takes an optional `realPathOf(file)` resolver. The session passes `desktopBridge()?.getPathForFile`. After a pick, the base folder is filled with the derived real folder, reusing `import-base-folder.ts`'s saving rules. The browser path is unchanged.
*Files:* `src/app/services/image-import/source-path.ts`, `batch-import-session.ts`, `base-folder-state.ts`, `image-import-modal.html` (desktop wording), specs.
*Verify:* specs with a fake resolver: a real path wins, an empty result falls back to the join, and the derived base folder is correct, including the case where the picked folder name repeats. Manual check on the host with the owner's real photo library against existing rows, for the mapped-drive and UNC dedupe risk in section 7.1.

**Task 2.4: Native pickers for backup and restore.**
When the bridge is present, "Choose folder..." / "Choose file..." call `pickFolder` / `pickBackupFile` and fill the box. The guess sentence is used only in the browser.
*Files:* `src/app/components/settings-modal/settings-modal.ts/.html`, `src/app/services/backup/*` as needed, specs (`settings-modal-backup.spec.ts` asserts two `webkitdirectory` inputs, so keep them for the browser).
*Verify:* specs with a fake bridge: a picked path lands in the box and no guess sentence appears. Without the bridge: the existing specs pass unedited.

**Task 2.5: Replace `window.prompt` in catalogue rename** (section 7.8).
*Files:* `src/app/components/category-modal/category-modal.ts/.html`, a pure helper for the save/ignore decision (+ spec).
*Verify:* specs show blank, unchanged and cancel each save nothing. Manual check in the browser: rename still works.

**Task 2.6: Desktop wording sweep** (section 7.9).
Collect desktop variants in one place (for example `src/app/services/desktop/desktop-wording.ts`) selected by `desktopBridge() !== null`.
*Files:* `http-utils.ts` (`describeHttpError` gets a desktop variant or a caller-side mapping), `image-import-modal.html`, `picked-folder.ts` callers, plus whatever the search finds.
*Verify:* a spec asserting that, with a fake bridge, none of the user-facing strings in the module contain `server`, `backend`, `browser`, `localhost`, `port` or `:3000`. The owner reviews the wording.

**Task 2.7: The data folder in Settings** (SQLite plan "Backup/restore", item 1).
Show the database path (already returned as `databasePath` by `GET /api/backup/suggestion`). Add "Open folder" in the desktop app (`openDataFolder`), and add "close the app before copying the file, or use Backup" text.
*Files:* settings modal, specs.

**Task 2.8: Build settings for a strict CSP, and the title.**
In `angular.json` production configuration add `"optimization": { "scripts": true, "styles": { "minify": true, "inlineCritical": false }, "fonts": true }`. Set `<title>Coin Inventory</title>` in `src/index.html`.
*Files:* `angular.json`, `src/index.html`.
*Verify:* after `npm run build`, `dist/coin-inventory-app/browser/index.html` contains **no inline `<script>` without `src`** and no `data-beasties` attributes. Add a check for this to `server/dist-path.spec.ts`'s "once a build has run" block, so it cannot come back. The app looks identical in the browser.

### Phase 3: the desktop package

**Task 3.1: Scaffold `desktop/`.**
Add `package.json` (exact `electron` pin, `electron-builder`, `esbuild`, `typescript`, `vitest`, `@playwright/test`), the `esbuild` → `esbuild-wasm` override, `tsconfig.json` and `vitest.config.mts`. Add `desktop/stage/` and `desktop/release/` to `.gitignore`. Add root scripts `desktop:dev`, `desktop:start`, `desktop:dist`, `desktop:dist:dir` and `test:desktop`.
*Files:* `desktop/*`, `.gitignore`, root `package.json` (scripts only).
*Verify:* `npm --prefix desktop install` (set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on the laptop if needed) and `npm run test:desktop` (empty, green). The root install is unaffected.

**Task 3.2: Pure main-process modules** (`data-paths`, `server-env`, `navigation-policy`, `csp`, `protocol-forward`).
*Verify:* table-driven specs. In particular, `data-paths`: with `LOCALAPPDATA` set on win32 it returns `...\CoinInventory`. On darwin it returns `userData`. An existing `COIN_INVENTORY_DATA_DIR` or `COIN_INVENTORY_DB_PATH` is never overridden. `navigation-policy`: every row of section 8.4.

**Task 3.3: `server-supervisor.ts`** (fork, ready with timeout, restart-once, shutdown with kill timeout).
*Verify:* specs with a fake `fork` covering ready, timeout, crash then restart, double crash then the "failed" outcome, and a graceful shutdown.

**Task 3.4: `ipc-handlers.ts` and `preload.ts`** (section 8.3).
*Verify:* specs: a handler rejects a sender URL outside the app, rejects bad arguments, and returns `null` on dialog cancel. The preload exposes exactly the listed keys; a spec checks the object's key list so nothing slips in.

**Task 3.5: `main.ts` wiring, `main-log.ts`, the application menu.**
On Windows use `Menu.setApplicationMenu(null)`; copy, paste and undo shortcuts keep working through Chromium. The mac target needs at least the standard `appMenu` and `editMenu` roles, built only when `process.platform === 'darwin'`.
*Verify:* covered by Task 3.7 and the smoke test.

**Task 3.6 [host]: `desktop:dev`.**
Electron loads `COIN_INVENTORY_DESKTOP_DEV_URL` with the bridge active, and `npm start` runs alongside it (`concurrently`).
*Verify:* on the host, the app opens in an Electron window with hot reload, and a folder pick shows real paths (once Task 2.3 is in).

**Task 3.7: `stage.mjs` and `desktop:start`.**
*Verify:* (laptop and host) `stage/` contains only `main.js`, `preload.js`, `package.json`, `server/server.js`, `server/assets/*` and `renderer/**`, with no `node_modules`. The plain-Node child test from section 10.2 passes. **[host]** `desktop:start` opens the app from `app://coin-inventory/` with real data from a temp `COIN_INVENTORY_DATA_DIR`.

### Phase 4: the installer

**Task 4.1: `electron-builder.config.cjs`** (section 9), and a spec that the staged version equals `package.json`'s `version.buildNumber`. The release script refuses to build while `SUPPORT_REPO_URL` is the placeholder (D5).
*Files:* `desktop/electron-builder.config.cjs`, `desktop/scripts/stage.mjs`, `desktop/src/version.spec.ts`.

**Task 4.2: Icons** (D6): `desktop/build/icon.ico` (16-256 px layers) and `icon.icns`.

**Task 4.3 [host]: First installer.**
Run `desktop:dist:dir`, then `desktop:dist`. Turn the fuses on and confirm the app still starts.
*Verify:* `release/Coin Inventory Setup 1.0.0.N.exe` exists, and installing it on the host and launching works.

### Phase 5: verification

**Task 5.1 [host]: Playwright smoke test** (section 10.2), `npm run test:desktop:e2e`.
**Task 5.2 [VM]: Full manual checklist** (section 10.3) on a clean Windows 11 VM. Record the results in a dated section appended to this plan.

### Phase 6: documentation

**Task 6.1: Rewrite README's "Status", "Prerequisites", "Run locally" and "Build" sections** for SQLite plus the desktop app. Add "Installing Coin Inventory" for end users, with the observed SmartScreen steps (section 4.11), where the data lives, how to back it up, and that uninstall keeps the collection. Update `docs/architecture.md` (add `desktop/`, fix the stale `mssql` rows), `server/README.md` (the new environment variables: `COIN_INVENTORY_API_TOKEN`, `COIN_SERVER_ASSETS_DIR`, `COIN_STATIC_DIR`, `COIN_DESKTOP_DIR`, `COIN_APP_VERSION`, `COIN_INVENTORY_DESKTOP`), and `setup/README.md` (the launchers are a development tool now).
**Task 6.2:** Update this plan's status and add the verification log.

---

## 12. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| `node:sqlite` missing or behaving differently inside Electron 45 or its `utilityProcess` | Low / high | Task 0.1 first. Fallbacks in section 4.1: the main process, then `better-sqlite3` behind `db/driver.ts`. |
| Electron cannot run on the author's laptop | High / medium | D4: shell work happens on the host. Everything in Phases 1 and 2, and staging, still runs on the laptop. |
| `app://` forwarding breaks XHR, module scripts, streaming uploads or IndexedDB | Medium / high | Task 0.1 (b). `withFetch()` fallback for HttpClient. The smoke test pins IndexedDB persistence. |
| Preferences lost every launch (the per-origin trap) | High if loopback is loaded directly | The custom protocol (section 4.3). Smoke test item 4. The scheme and host must never change. |
| Firewall prompt | Low (loopback) / high | Bind `127.0.0.1` explicitly (Task 1.3). `netstat` check on the VM. |
| UI freezes on large operations | Medium / medium | The server runs in a `utilityProcess` (section 4.1). |
| Strict CSP silently unstyles the app | High if missed / high | Task 2.8 removes the inline script, and the dist spec stops it coming back. |
| Paths imported in the browser era (UNC or typed) do not dedupe against real desktop paths | Medium / low (duplicate photos, not lost data) | Task 2.3 manual check on real data. Release note. The relocation tool (later) can normalise them. |
| A schema change in a later release with no migration runner | Certain eventually / high | Out of scope. Task 1.9 at least makes a newer file visible to the user (D12). The first schema-changing release must ship the `user_version` runner first. |
| Restore while the development copy is also running (D9) | Low / high | Document. The single-instance lock covers two desktop copies. |
| Unsigned installer scares users away | Medium / medium | Accepted (design section 4.11). README written from the observed screens. |
| Merge conflicts with the 2026-11-18 photo-sets work in the import screen | Medium / low | Do Task 2.3 after that work lands, or coordinate. |
| electron-builder's helper binaries change behaviour between versions | Low / medium | Pin `electron-builder` exactly too. One major at a time (section 17). |
| A test or smoke run touches the owner's real collection | Low / severe | Every desktop test sets `COIN_INVENTORY_DATA_DIR` to a temp folder, and the smoke test asserts the real folder's modification time is unchanged (section 10.2 item 7). |

---

## 13. Explicitly out of scope

- **Auto-update** (design non-goal for v1). Do not add `electron-updater` or a `publish` block. The config should not even reference a release feed.
- **A Mac release.** The `mac` target exists, is reviewed, and is never built or tested here (cross-platform item 3, "do not let Mac delay Windows").
- **Code signing** (design section 4.11).
- **Section 4.9 / 4.9a image storage changes, the photo-relocation tool (section 4.4), the SQLite migration runner** (only the "refuse newer" guard of Task 1.9 is in scope).
- **Replacing Express with IPC** (design section 6 calls it a later optimisation).
- **Removing the build-time overrides** (`esbuild-wasm`, `sass`) or `ng-wasm-safe.mjs`. That happens when builds leave the laptop (dealer-readiness section 17), which is separate work.
- **A one-click "Save as PDF"** (D8) and **"open in Windows Photos"** (D7-B), unless the owner chooses them.
- **Multi-user, LAN access or cloud** (design non-goals). The desktop server is loopback-only by design. The browser workflow keeps its current bind for development.
