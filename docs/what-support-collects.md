# What "Report a problem" collects

Coin Inventory has a **Help → Report a problem** button. This page says exactly
what it puts in a report, what it never puts in one, and what happens to the
file afterwards.

Short version: **it tells you what is in the report before anything is
written, it will show you the report itself if you ask for it, and it never
sends anything by itself.**

---

## How the dialog works

There are two screens, not three.

1. **Describe the problem.** You type what happened, and decide whether to
   **include your recent log** (see below). Underneath, in plain words, is a
   list of everything that will be sent — including how many errors were
   recorded — and that list changes when you untick the log, so you can
   always see which way round it is. A collapsible **Show the exact report
   text** box holds the report itself, exactly as it will be written, for
   anyone who wants to read it. It is optional, and most people will not want
   it: it is technical markup.
2. **Done.** A plain `.md` file is on your Desktop — with a `.txt` of your
   recent log beside it if you asked for one — and your browser is at a
   pre-filled issue. Nothing has been uploaded.

The report text used to be a compulsory middle screen with an editable box. It
was removed because a wall of generated markup that most people cannot
evaluate does not help anyone decide anything — it just teaches you to click
past it. Nothing about what is collected or what is replaced changed with it:
the list is still shown, the exact text is still one click away, and nothing
is written until you press the button.

---

## What goes in

| | |
|---|---|
| App, server and Node versions | So a bug can be matched to a release. |
| Your Windows version and processor type | Most "it works for me" differences live here. |
| How big your collection is | **Counts only** — how many coins, how many photos, and how many coins are marked sold. |
| Errors you saw in the app this session | The failures behind the red messages. |
| The most recent log lines | Only if you leave **Include recent log** ticked. Roughly the last two or three minutes of activity. |
| The names and sizes of your log files | Names and sizes. Not their contents. Sent either way. |
| Anything you typed in the box | |

## What never goes in

- **Your coins.** Not one coin, grade, price, note, purchase, catalogue number
  or photograph. The collection appears as counts and nothing else.
- **Your photographs.**
- **Any file of yours.** The app has no file picker and cannot attach or
  upload anything. See below.
- **Anything at all, automatically.** No report is created, saved or sent
  unless you press the button.

---

## What gets replaced before anything is written

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

The report tells you what was replaced and how many times — in the file, and in
the dialog's **Show the exact report text** box if you open it. That summary
never contains the original values.

The same applies to the file's own location. The issue the app opens for you
names the report file so you can find it, but as
`C:\Users\<USER>\Desktop\…` rather than your real path, because the issue is
public and you already know who you are.

---

## Include recent log

The describe screen has one choice on it: a tick-box marked **Include recent
log**. It starts ticked.

**Ticked.** A second file is written next to the report:
`coin-inventory-log-<date>-<time>.txt`, holding up to the last 2,000 lines of
your log. It is **redacted exactly as the report is** — same pass, same
placeholders — so a folder shown as `C:\Users\<USER>\…` in the report is the
same folder shown as `C:\Users\<USER>\…` in the log. You get two files you can
drag into the issue; there is still no zip.

**Unticked.** **No log lines are sent at all.** No second file is written, and
the log tail that would otherwise sit inside the report is left out of it too.
"Include the log" means all of it, so unticking cannot leave a hundred and
fifty lines behind where you would not think to look. The report says, in the
place the log would have been, that you chose not to include it.

Either way the **names and sizes** of your log files still go. Those are not
log contents — they answer "is it even writing a log", nothing more — and the
summary on screen says so.

Why offer the choice at all: a log is the most useful thing in a bug report,
which is why it is ticked by default. But not every report is a bug report. A
suggestion does not need your log, and sending one anyway would assume
something about you that is not true.

Why the log is written as a file rather than pasted into the report: the
report is meant to be *read*, on the issue, by someone deciding whether to
care. Two thousand log lines in the middle of it would bury the three
paragraphs that say what went wrong.

> The log file is the **safe** way to share a log. The app's own `app.log` has
> never been through the redactor — it has your user name, your computer name
> and your photo folders in it, in plain text. Attach the `.txt` this dialog
> writes, not that one.

---

## Attaching your own files

**The app cannot do this for you, and it no longer pretends to.**

There is no file picker in the dialog. GitHub has no official way for a
program to put a file on an issue, and the app holds no GitHub credential —
so a picker could only have collected your file and then quietly dropped it.
Not offering is better than that.

Files reach an issue one way: **you drag them in yourself on GitHub.** The
dialog gives you the address as a clickable link, on both screens, so you
never have to go looking for it.

> **Anything you attach goes into a public GitHub issue that anyone can read,
> download and keep.**

Nothing you drag in is edited or redacted by anyone. The redaction described
above applies to the report the app writes — not to a file you add yourself.

This is not a theoretical worry. QIF exports from this project's own author
turned out to contain stock holdings, a 401K, a street address and a private
company name. They were removed from this repository for exactly that reason.

So: **open the file and look at it first.** A spreadsheet or a QIF can hold far
more than coins.

### Why there is no zip

The app used to put the report and your files into a `.zip`. It does not any
more.

Zipping a report gains nothing — it is already text — and zipping a photo
actively hides it: GitHub displays an image you drag onto an issue right there
in the page, where the same image inside a zip is invisible until somebody
downloads and extracts it. If you have a lot to send, you can make your own
zip; the app will not make one for you.

---

## What happens when you press the button

1. A plain **`.md` file** is written to your **Desktop**, and a plain `.txt`
   of your recent log beside it if you left the box ticked. Nothing is
   uploaded. The dialog tells you both full paths.
2. Your browser opens a **pre-filled GitHub issue**. You can still edit it, and
   you can close it without submitting.
3. Drag in whatever you want to include — those files, a screenshot, an
   export — then press Submit.

Step 3 is manual because GitHub has no way for an application to attach a file
to an issue. It is also why the app ships **no GitHub credential of any kind** —
any token inside a program on your computer can be pulled out of it, so there
is not one to find.

If the report is too long to fit in a browser link, it is copied to your
clipboard instead and the app tells you to paste it in. It is never silently
shortened.

If no repository has been configured for your copy of the app, no browser is
opened and no link is shown — the app says so rather than sending you to a page
that does not exist. The report file is still saved, and you can send it on
however you like.

### The files contain

The `.md` is the report and only the report: the environment table, the
collection counts, the recent errors, the log tail (if you asked for it), and
the summary of what was replaced. It is plain Markdown, so you can open it in
Notepad and read every word before you decide to send it.

The `.txt`, if one was written, is your recent log and nothing else, with the
same replacements already made. It opens in Notepad too.

---

## Logs

The app keeps **one log file per day**, each capped at 5 MB, and deletes them
after about **two weeks**. They live beside the application data, not inside
your collection.

That limit is partly practical — nobody can send a log that grows forever — and
partly about privacy: anything a log remembers about where your files used to
live stops existing after a fortnight.

You can delete the log folder at any time. The app will make a new one.
