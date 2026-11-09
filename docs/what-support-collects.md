# What "Report a problem" collects

Coin Inventory has a **Help → Report a problem** button. This page says exactly
what it puts in a report, what it never puts in one, and what happens to the
file afterwards.

Short version: **it shows you everything before anything is written, and it
never sends anything by itself.**

---

## What goes in

| | |
|---|---|
| App, server and Node versions | So a bug can be matched to a release. |
| Your Windows version and processor type | Most "it works for me" differences live here. |
| How big your collection is | **Counts only** — how many coins, photos and transactions. |
| Errors you saw in the app this session | The failures behind the red messages. |
| The most recent log lines | Roughly the last two or three minutes of activity. |
| The names and sizes of your log files | Names and sizes. Not their contents. |
| Anything you typed in the box | |
| Files **you** chose to attach | Nothing is attached unless you pick it. See below. |

## What never goes in

- **Your coins.** Not one coin, grade, price, note, purchase, catalogue number
  or photograph. The collection appears as counts and nothing else.
- **Your photographs.**
- **Anything at all, automatically.** No report is created, saved or sent
  unless you press the buttons.

---

## What gets replaced before you see it

Log lines contain file paths, and file paths contain your name. A real line
looks like this:

```
Connecting to SQL Server at MYSERVER\SQLEXPRESS/CoinInventory
  at formatDate (C:/Users/devuser/source/dev/server/server.ts:130:12)
```

Before the report is built, these are replaced:

| Replaced with | What it was |
|---|---|
| `<USER>` | Your Windows user name, wherever it appears |
| `<USER2>`, `<USER3>`… | Any other account name found in a path |
| `<MACHINE>` | Your computer's name |
| `<MACHINE2>`, `<MACHINE3>`… | Any other computer or server named in a path |
| `<REDACTED>` | Anything resembling a password, token, API key or connection-string credential |
| `<EMAIL>` | An email address |

So the lines above become:

```
Connecting to SQL Server at <MACHINE>\SQLEXPRESS/CoinInventory
  at formatDate (C:/Users/<USER>/source/dev/server/server.ts:130:12)
```

**The same real value always becomes the same placeholder**, so two lines about
the same folder still read as the same folder. Two *different* accounts never
collapse onto one placeholder, so the report never invents a connection that is
not there.

The report tells you what was replaced and how many times. That summary never
contains the original values.

---

## Attaching your own files

This is a separate, deliberate step, and it is the one to read carefully.

> **Anything you attach goes into a public GitHub issue that anyone can read,
> download and keep.**

Attachments are **not** redacted — a QIF with `<USER>` substituted into it is a
broken QIF, and the whole point of sending one is that it can be replayed. Your
files go up exactly as they are on your disk.

This is not a theoretical worry. QIF exports from this project's own author
turned out to contain stock holdings, a 401K, a street address and a private
company name. They were removed from this repository for exactly that reason.

So:

- Nothing is attached unless you choose it, **file by file**.
- You must tick a box confirming you have read the warning before the file
  picker will do anything. Un-ticking it discards everything you had staged.
- **Open the file and look at it first.** A spreadsheet or a QIF can hold far
  more than coins.

---

## What happens when you press the button

1. A `.zip` is written to your **Desktop**. Nothing is uploaded.
2. Your browser opens a **pre-filled GitHub issue**. You can still edit it, and
   you can close it without submitting.
3. You drag the `.zip` into the issue yourself, then press Submit.

Step 3 is manual because GitHub has no way for an application to attach a file
to an issue. It is also why the app ships **no GitHub credential of any kind** —
any token inside a program on your computer can be pulled out of it, so there
is not one to find.

If the report is too long to fit in a browser link, it is copied to your
clipboard instead and the app tells you to paste it in. It is never silently
shortened.

### The zip contains

```
report.md                the text you approved
logs/recent.log          a longer, redacted log tail
redaction-receipt.txt    what was replaced, and how many times
attachments/...          only the files you chose
```

---

## Logs

The app keeps **one log file per day**, each capped at 5 MB, and deletes them
after about **two weeks**. They live beside the application data, not inside
your collection.

That limit is partly practical — nobody can send a log that grows forever — and
partly about privacy: anything a log remembers about where your files used to
live stops existing after a fortnight.

You can delete the log folder at any time. The app will make a new one.
