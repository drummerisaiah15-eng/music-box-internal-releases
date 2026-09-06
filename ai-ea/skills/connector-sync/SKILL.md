---
name: connector-sync
description: Pull calendar events, receipts and bank statements into a client workspace from Gmail, Google Calendar, Drive, Dropbox or a CSV export. Use when the workspace is stale, before producing a brief or reconciliation, when a client sends a statement, or when asked to catch up on someone's inbox, calendar or receipts.
---

# Getting real data into the workspace

You fetch; the engine merges. That split is deliberate and worth understanding
before you run anything, because the merge rules are what stop a re-sync
destroying a month of classification work.

## The one rule that matters

**A sync must never overwrite a human decision.** Categories, business
purposes, attendees, which entity a receipt belongs to — these are judgement
calls somebody made, and the engine protects them: it remembers what the feed
last supplied, so a field a person has since changed is left alone forever,
while an untouched field still benefits when extraction improves.

You do not have to implement any of that. You have to not work around it. Never
hand-edit `documents.json` to "fix" a sync, and never pass `--mode full` unless
the batch really is the complete picture.

## Fetching

Use whichever connector the client has granted, and shape the results into the
records below. Every record needs a **`sourceId`** — the id the source itself
uses. That is what makes re-syncing idempotent; without it the same receipt
lands twice every morning.

### Calendar

```
ai-ea sync calendar --source gcal --mode full --json '[
  {"sourceId":"<event id>","title":"...","start":"2026-09-06T15:00:00Z",
   "end":"2026-09-06T16:00:00Z","location":"Studio A"}
]'
```

Fetch today plus the next 14 days and pass `--mode full`. A calendar fetch for
a window really is the whole picture for that window, so cancellations are
detectable. Withdrawn events stay in the file as history but drop out of the
brief automatically.

### Receipts and invoices from mail or file storage

```
ai-ea sync documents --source gmail --json '[
  {"sourceId":"<message id>-<attachment index>","date":"2026-03-14",
   "entity":"NMS","docType":"RECEIPT","counterparty":"Sweetwater Sound, Inc.",
   "amountCents":"$1,284.99","reference":"INV-10233","extension":"pdf"}
]'
```

Use `--mode incremental` (the default). You are searching a window of mail, not
enumerating every receipt that exists, so an absence means nothing.

Read the amount, date and vendor off the document itself. **Do not guess a
category** — leave it out and let it surface as a gap for the principal to
answer. A wrong category that looks confident is worse than an obvious blank,
because nobody goes back to check it.

### Bank and card statements

```
ai-ea import-csv ~/Downloads/amex-march.csv --account "amex-1005"
```

This is usually better than an API: clients can export a CSV in thirty seconds,
it needs no credentials, and it is the bank's own record. The importer handles
the variations between banks — delimiters, preambles, debit/credit pairs versus
a single signed column — and tells you what it concluded:

```
Read 47 transactions (month-first dates, header on line 4).
Columns used: date="Transaction Date", description="Description", amount="Amount".
44 out, 3 in — negative amounts read as money out.
2 rows skipped:
  - line 31: no amount in any amount column (PENDING)
```

**Read that summary rather than skipping past it.** If the sign convention or
the date format is wrong, everything downstream is wrong in a way that looks
fine. If it refuses because every date is ambiguous — no day above 12 anywhere
in the file, so `03/04` could be either — get the client to re-export with ISO
dates rather than passing `--date-format` on a hunch.

Statement imports are always incremental, because an export covers a period and
treating it as complete would withdraw the rest of the year.

## After every sync

Read the report. Three things need you:

**Conflicts** — something changed at the source after it had been classified
here. The engine keeps the human's decision and flags the change:

```
1 needs your eyes — changed at the source after being classified here:
  - gmail-msg-1: amountCents was 128499, now 129999
```

Go and look. One of the two readings is wrong, and which one matters.

**Rejected** — records that could not be read. Each says why. A handful of
rejects on a large batch is normal; a batch that is mostly rejects means the
shape you are producing is wrong, so fix the fetch rather than the data.

**Withdrawn** — gone from the source. For a calendar that is a cancellation and
usually fine. For a receipt it means a document disappeared from the client's
storage, which is worth a question.

## Running it without you

`ai-ea fetch` runs the configured fetchers that are due and merges what they
return. A fetcher is any command that prints a JSON array to stdout, declared
in the workspace's `fetchers.json`:

```json
{
  "sources": {
    "gcal": {
      "collection": "calendar", "mode": "full", "everyMinutes": 60,
      "command": ["claude", "-p",
        "Fetch this calendar between {{since}} and {{until}}. Print ONLY a JSON array of {sourceId,title,start,end,location}."]
    },
    "statement-drop": {
      "collection": "statements", "kind": "file-drop", "everyMinutes": 1440,
      "directory": "~/Dropbox/northside", "account": "amex-1005", "entity": "NMS"
    }
  }
}
```

`{{since}}` and `{{until}}` are substituted into the arguments, and also arrive
as `AI_EA_SINCE` / `AI_EA_UNTIL`. The window starts a little before the last
**successful** fetch, so records that arrive backdated — an email timestamped
yesterday, an edit to a meeting that already happened — are still picked up.

**When you are the fetcher, print only the array.** A log line before it is
tolerated, but anything else is refused rather than half-read. Set `sourceId`
to the source's own id for every record; without it the same receipt lands
again every run.

The `file-drop` kind needs no credentials at all: a client exports a CSV into a
shared folder and it is read on the next run, then moved to `imported/` rather
than deleted, because a statement read wrongly has to be re-readable.

### What a failure means

A failed fetch does not advance the watermark, so the next run asks for the
same period again — nothing is quietly skipped. Repeated failures back off
exponentially so a revoked token stops filling the log, and `ai-ea fetch-status`
names anything that has gone quiet:

```
[STALE] gcal → calendar: last success 19 hours ago, expected every 1 hour
          last error: the fetcher exited 3: token expired
```

Check that before trusting a thin brief. A stale feed and an empty one produce
exactly the same output, and only one of them is real.

## Cadence

- **Calendar** — before every brief. It is the fastest-moving thing you hold.
- **Receipts** — daily; the business purpose for a meal is recoverable the same
  week and gone by April.
- **Statements** — weekly, and always before a reconciliation. `ai-ea reconcile`
  is only as honest as the last import.

`ai-ea sync-status` shows when each source last ran and what it did. Check it
when a brief looks thin — a stale calendar and an empty one look identical in
the output, and only one of them is real.
