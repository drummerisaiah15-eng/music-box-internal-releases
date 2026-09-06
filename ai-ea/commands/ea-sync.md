---
description: Pull fresh calendar, receipts and statements into the workspace
---

Bring the workspace up to date: $ARGUMENTS (default: everything).

Follow the `connector-sync` skill.

1. **Calendar** — fetch today plus 14 days from the client's calendar and
   `ai-ea sync calendar --source <name> --mode full`.
2. **Receipts** — search mail and file storage since the last sync
   (`ai-ea sync-status` says when that was), read amount, date and vendor off
   each document, and `ai-ea sync documents --source <name>`. Do not guess a
   category; leave it blank so it surfaces as a gap.
3. **Statements** — if the client has sent an export, `ai-ea import-csv`.
   Read the import summary: a wrong sign convention or date format makes
   everything downstream wrong in a way that looks fine.
4. **Report** what changed, and act on the three things that need a human:
   conflicts (something changed at the source after it was classified here),
   rejects (say what shape the fetch should have produced instead), and
   withdrawals (a cancelled meeting is fine; a vanished receipt is a question).

Never hand-edit the collection files to work around a sync result.
