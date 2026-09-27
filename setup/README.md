# Coin Inventory setup

This folder holds the Node.js installer helper and a compatibility shim for the
older launcher path. The launcher that actually does the work lives in the
**project root**, not here.

## Preferred startup

Double-click **`launch-coin-inventory.cmd`** in the project root.

In Windows Explorer it may appear as just `launch-coin-inventory`, without the
`.cmd`, because Explorer hides known file extensions by default — look for the
file with the gear/cog icon.

## Every entry point, and what it really is

These are all the launcher-related files that exist. Only two of them contain
any real logic.

### Project root

| File | What it is |
| --- | --- |
| `start-coin-inventory.ps1` | **The real launcher.** Everything described below is this file. |
| `launch-coin-inventory.cmd` | A double-click wrapper. Runs the `.ps1` above with `-NoProfile -ExecutionPolicy Bypass`, and pauses on failure so the error is readable. (The previous version ended with an unconditional `exit /b 0`, which closed the window instantly and left no way to see why it failed.) |
| `run-coin-inventory.ps1` | Started *by* the launcher, as a child process. It does nothing but `Set-Location` to the project and run `npm start`. It deliberately never touches the lock file — an earlier version deleted it here, which let the child remove the launcher's own lock while the launcher was still running, so a second launch saw no lock and started a duplicate set of servers. |

An `open-edge.ps1` used to sit alongside these. It predated the launcher
opening the browser itself, and it still had the old behaviour: poll port 4200
only, and do nothing at all if any Edge window was already open. Nothing
called it. It has been deleted rather than left in place, because a script
that waits on the dev server but not on `/api/health` reintroduces exactly the
startup race the launcher was fixed to avoid.

### This folder (`setup/`)

| File | What it is |
| --- | --- |
| `install-node.ps1` | **Real, and still used.** Installs Node.js LTS via `winget`. The root launcher invokes it automatically if `node` is not on the PATH. |
| `start-coin-inventory.ps1` | A compatibility shim. It resolves the root launcher and calls it. No logic of its own. |
| `start-coin-inventory.cmd` | A `.cmd` wrapper around the shim above, so the old command-prompt path keeps working. |

So the older entry points still function:

```powershell
# From the project root — this is the real launcher
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-coin-inventory.ps1
```

```cmd
:: Still works; forwards to the root launcher via the shim
setup\start-coin-inventory.cmd
```

## What the launcher does

1. **Single-instance check.** It writes its own PID to `.coin-inventory.lock`
   in the project root. If that file exists and names a process that is still
   alive, it prints "Coin Inventory is already running" and exits without
   starting anything. A stale lock — left behind by a crash or a hard kill — is
   simply removed and startup continues. The lock is deleted in the launcher's
   own `finally` block, so it is cleaned up even on failure.
2. **Checks for Node.js**, and runs `setup\install-node.ps1` if it is missing.
3. **Installs dependencies only when `node_modules` is actually absent** — it
   checks both the project root and `server/`. Not on every run. The old
   launcher in this folder ran `npm install` every single start, which is slow
   against a network share and turned any transient npm hiccup into a failed
   launch. Dependencies do not change between runs, so it checks instead of
   reinstalling.
4. **Starts the servers**, by running `run-coin-inventory.ps1` as a child
   process, which runs `npm start`. That clears anything stale off ports 3000
   and 4200 first, then runs the Express API and the Angular dev server
   together.
5. **Waits until BOTH are genuinely ready** (see below), giving up after 180
   seconds with a message naming whichever one never came up. If the server
   process exits while it is waiting, it stops polling immediately and reports
   the exit code rather than sitting there for three minutes.
6. **Opens Edge** at `http://localhost:4200`.
7. **Stops the server process tree** when the browser window closes, using
   `taskkill /T /F` so the `npm`, `concurrently` and `node` children all go
   with it, not just the top-level process.

## Why it waits for both servers

The Angular app calls `InventoryService.hydrate()` exactly once, at startup. If
the browser opens before the API on port 3000 is accepting requests, that single
hydration attempt fails and the app shows "Cannot connect to database" even
though the backend comes up a second later.

The old launcher only polled port 4200 (the Angular dev server), which is
usually — but not always — slower to start than the API. That race is why
startup used to "usually work but occasionally fail".

So there are two separate probes:

- **Web app:** `http://localhost:4200` returning HTTP 200. The dev server only
  has to be serving `index.html`, so the status code is enough.
- **API:** `GET http://localhost:3000/api/health` returning 200 **and** a body
  of `{"status":"ok","database":"connected"}`. The health route runs a
  `SELECT 1` against SQL Server, so a 200 there means the database has actually
  answered — not merely that Express is listening.

**The body check is not belt-and-braces, it is load-bearing.** The Express
server has an Angular SPA catch-all route (`app.get('*')`) that returns
`index.html` with a **200** for any unmatched GET. Checking only the status code
would make a missing or misnamed `/api/health` look perfectly healthy, and the
launcher would open the browser too early — the exact bug it exists to prevent.
A 503 from the health endpoint (Express up, database down) also fails the check,
which is what we want: keep waiting rather than opening the app.

That response shape is a contract between the launcher and
`server/routes/health.ts`. Do not change one without the other.

## Why Edge opens with your normal profile

The launcher starts Edge with `--new-window` and **no `--user-data-dir`**, i.e.
your ordinary profile, on purpose. The app stores its UI preferences — visible
columns, app settings — in the browser's **IndexedDB**. Launching with a
throwaway `--user-data-dir` would hand the app a blank profile and silently
reset all of those every single time you started it. (Coin data itself lives in
SQL Server and would be unaffected either way; it is the UI state that would be
lost.)

The catch this creates: if Edge is *already* running, the `msedge.exe` the
launcher starts just hands the URL to the existing instance and exits
immediately. `Wait-Process` would then return within a second and the shutdown
block would kill the servers moments after starting them. So the launcher waits
three seconds, checks whether its browser process survived, and if it did not,
waits on the **server** process instead — in that case the console window it
was started from becomes the thing you close to shut the app down, and it tells
you so.

## Notes

- **Database migrations are not applied by the launcher.** If your database
  already contains coins, apply the outstanding scripts in
  `server/migrations/` by hand — see the migrations section of
  `server/README.md`. Re-running `server/setup-database.sql` is **not** an
  upgrade path: it drops every table before recreating them, so it is only for
  building an empty database.
- There used to be two separate launchers, one here and one in the project
  root, with different readiness checks and different lock files (this one used
  `%TEMP%`, the root one uses the project directory). Because the lock files
  differed, launching both at once started two sets of servers competing for
  ports 3000 and 4200. There is now a single implementation.
- Two other behaviours of the old launcher in this folder were deliberately not
  carried over: a cleanup routine that killed any process whose command line
  contained the app directory *and* the substring `server` (broad enough to
  terminate an editor or a terminal that merely had the project open), and
  guessing the browser process by enumerating `msedge.exe` and taking the
  newest one (Edge spawns renderer and GPU children, so this could latch onto
  a short-lived helper and shut the app down moments after it started).
- If the app still fails to connect to SQL Server, run the backend directly so
  you can see its startup output in your own console:
  ```powershell
  cd server
  npx tsx server.ts
  ```
  You can also check the health endpoint by hand:
  ```powershell
  Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health |
      Select-Object -ExpandProperty Content
  ```
- The app depends on the local SQL Server database, and on
  `server/setup-database.sql` for the canonical lookup data (categories,
  denominations, mint marks, metal contents).
- Errors are logged to `server/logs/app.log`, which is the first place to look
  when startup fails.
