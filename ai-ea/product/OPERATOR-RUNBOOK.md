# Operator runbook

How to actually run this, day to day. Internal — this is the document you or
whoever operates the service works from.

## The three parts

**The engine** (`ai-ea`, the CLI) computes. Ledger arithmetic, dates, ordering,
reconciliation, authority decisions. It runs anywhere Node runs, has no
dependencies and no network access, and gives the same answer twice.

**Claude** holds the connectors and does the judgement: reading mail, deciding
what a message obliges, drafting in the principal's voice, researching, and
explaining. It drives the engine rather than reimplementing it.

**You** set the authority limits and answer the decisions the system escalates.

The split is the point. Anything a client would be upset to have wrong is
computed, not estimated.

## One-time install

```bash
git clone git@github.com:drummerisaiah15-eng/ai-ea.git ~/ai-ea
cd ~/ai-ea && npm test          # 273 tests, nothing to install

cp -r skills/*   ~/.claude/skills/
cp -r commands/* ~/.claude/commands/
cp -r agents/*   ~/.claude/agents/
```

That last step is what gives you `/ea-brief`, `/ea-triage`, `/ea-sync`,
`/ea-week` and the rest inside Claude.

## Per client — about twenty minutes

Send `CLIENT-INTAKE.md` before the kickoff call. Then:

```bash
ai-ea init -w ~/clients/northside --client northside
```

Fill in `client.json` from their answers — the five that matter are the spend
limit, the auto-send domains, the review-first list, the entities, and the
voice. Then:

```bash
ai-ea readiness -w ~/clients/northside
→ Onboarding readiness: 100% (operational)
```

**Do not start executing below 100%.** A half-configured assistant interrupts
constantly, and you will spend a month untraining the client's expectation that
it always will.

Set the workspace once per shell so every later command finds it:

```bash
export AI_EA_WORKSPACE=~/clients/northside
```

### Day one: the backlog sweep

Everything already owed goes into the ledger before you do anything else. Use
the `ea-backlog-sweep` agent over their mail and notes. Expect to find
obligations nobody was tracking — there always are, and it is the single most
persuasive thing you will show them in week one.

## The working day

### Morning

```bash
ai-ea sync calendar --source gcal --mode full --json "$(fetch)"
ai-ea brief
```

In Claude that is just `/ea-brief`. Sync first: a stale calendar and an empty
one look identical in the output, and only one of them is real.

The brief leads with decisions. Add your recommendation to each one before it
goes to the client — a decision handed over without one is unfinished work.

```
**2 need you · 1 overdue · 2 due today · 0 being chased · 0 closed**

## Needs a decision from you (2)
- **Approve $3,400 recital hall deposit?**
  - Above your $500 standing limit
  - My recommendation: Approve — only hall free on the 30th, refundable to the 20th.
- **Fall term piano tuning — Marcus at Halvorsen has not responded after 2 chases.
  Do you want to push, or should I let it go?**

## Today's shape
3 meetings, 2.67h booked, 10:00–14:45 Chicago.
- 10:00–11:00 Fall recital planning — Studio A
- 11:05–12:00 Bank — line of credit — First National, downtown
- **Not enough travel time** — 5 min between Studio A and First National.
```

### Through the day

`/ea-triage` on the inbox. Every obligation buried in a thread becomes a ledger
row with an owner and a clock. Before anything leaves the building:

```bash
ai-ea authority --json '{"type":"send_email","recipient":"...","subject":"..."}'
```

| | |
|---|---|
| `ap@sweetwater.com` | PROCEED — allowlisted |
| `parents@okonkwo.net` | DRAFT-FOR-APPROVAL — outside the allowlist |
| `ops@firstnational.com` | DRAFT-FOR-APPROVAL — review-first list |
| anything mentioning the IRS | DRAFT-FOR-APPROVAL — sensitive topic |
| `spend` $3,400 vs a $500 limit | DRAFT-FOR-APPROVAL — over the limit |
| `sign` anything | REFUSE — never delegated, any configuration |

When it says draft, write the message **complete and ready to send**, so
approval is one word rather than a project.

### Midday

```bash
ai-ea followups
→ [escalate] Fall term piano tuning → Marcus at Halvorsen (attempt 3)
      Marcus has not moved after 2 chases; needs your weight behind it.
```

Chases go out at the right register for the attempt number — first friendly,
second naming the consequence. An escalation is never a fourth email; it is a
real question to the principal. Log every chase.

### End of day

Log what closed. This is not bookkeeping for its own sake — the "closed since
yesterday" section of tomorrow's brief is what answers *what am I paying for*
before the client has to ask.

## The weekly close

`/ea-week`, or by hand:

```bash
ai-ea import-csv ~/Downloads/amex-march.csv --account amex-1005 --entity NMS
ai-ea sync documents --source gmail --json "$(receipts)"
ai-ea reconcile
```

```
Read 5 transactions (month-first dates, header on line 4).
4 out, 1 in — negative amounts read as money out.

Matched 3/4 lines (78% of dollars).
Unreceipted exposure: $612.40.
  - 2026-03-09 DELTA AIR 0062199 $612.40
```

**Read the import summary.** If the sign convention or the date format is
wrong, everything downstream is wrong in a way that looks fine.

**Always pass `--entity`.** Without it the same card is counted against every
set of books, and the packet will (correctly) refuse to be ready until you say
whose account it is.

Then batch the substantiation asks into one message — never six pings. Meals
need attendees and a business purpose; travel needs a purpose. These are
answerable the same week and unanswerable in April.

## What survives a re-sync

Anything a person decided. Categories, business purposes, attendees, which
entity a receipt belongs to. The engine records what the feed last supplied, so
a field somebody has changed is theirs permanently — even while the feed keeps
insisting otherwise every week.

Two rules for staying on the right side of that:

- **Never hand-edit a collection file to "fix" a sync.** Fix the fetch.
- **Never pass `--mode full` unless the batch really is the complete picture.**
  Full mode concludes that anything missing was withdrawn. Right for a calendar
  window; catastrophic for a statement export covering one month.

## Year end

```bash
ai-ea cpa-packet --year 2026 --entity NMS
```

Scoped to one year *and* one entity. It reports its own gaps and refuses to
call itself ready while any remain:

```
Documents: 2 · Statement lines: 5
Business total: $2,134.99
Receipt coverage: 77% of dollars · Readiness: 84%

## Open questions (2)
- 2026-03-02 TST* BLUE BOTTLE #22 $42.10 has no receipt — locate it or confirm personal.
- 2026-03-09 DELTA AIR 0062199 $612.40 has no receipt — locate it or confirm personal.

Status: not ready to send — clear the open questions above first.
```

Send it with the gaps visible. A packet that hides what is missing costs a
billable hour and a round trip; one that leads with "here are the two things I
could not resolve" gets answered in one.

## Running it unattended

Declare the fetchers once per client in `fetchers.json`, then let cron drive it:

```json
{
  "sources": {
    "gcal": {
      "collection": "calendar", "mode": "full", "everyMinutes": 60,
      "command": ["claude", "-p",
        "Fetch this calendar between {{since}} and {{until}}. Print ONLY a JSON array of {sourceId,title,start,end,location}."]
    },
    "gmail-receipts": {
      "collection": "documents", "everyMinutes": 240,
      "command": ["claude", "-p",
        "Find receipts in mail between {{since}} and {{until}}. Print ONLY a JSON array of {sourceId,date,entity,docType,counterparty,amountCents,extension}. Do not guess a category."]
    },
    "statement-drop": {
      "collection": "statements", "kind": "file-drop", "everyMinutes": 1440,
      "directory": "~/Dropbox/northside", "account": "amex-1005", "entity": "NMS"
    }
  }
}
```

```cron
*/30 * * * *   cd ~/clients/northside && ai-ea fetch
0 6  * * 1-5   cd ~/clients/northside && ai-ea brief      | mail -s "Brief"  you@…
0 12 * * 1-5   cd ~/clients/northside && ai-ea followups  | mail -s "Chases" you@…
0 8  * * *     cd ~/clients/northside && ai-ea fetch-status | grep -q STALE && \
                 ai-ea fetch-status | mail -s "Feeds gone quiet" you@…
0 17 * * 5     cd ~/clients/northside && ai-ea reconcile  | mail -s "Weekly" you@…
```

`ai-ea fetch` only runs what is due, so a half-hourly cron is cheap. Each source
has its own interval, and a failing one backs off rather than filling the log.

Three things worth understanding before you trust it:

**A failure never advances the watermark.** The window is anchored on the last
*successful* fetch, so a run of failures widens it instead of leaving a hole.
Nothing is skipped over silently — which is the whole reason this is worth
building rather than a `while true` loop.

**Windows overlap on purpose.** Each fetch re-asks for a couple of hours before
the last success, because sources backdate: an email arrives timestamped
yesterday, someone edits a meeting that already happened. The merge is
idempotent, so the overlap costs nothing.

**The file-drop adapter needs no credentials.** The client exports a CSV into a
shared folder and it is read on the next run. This is often the best statement
route: nothing to authorise, nothing to revoke, and it is the bank's own record.

What cron still cannot do is the judgement — reading mail properly, drafting,
adding the recommendation to each decision. That remains yours.

## Two honest limits

**Fetching still needs a live Claude session.** Calendar events and receipts
reach the workspace when Claude pulls them through its connectors. Bank data
needs nothing — a client can export a CSV in thirty seconds. For one or two
clients this is fine; past three, a background fetch job is the next thing to
build.

**One workspace, one writer at a time.** Concurrent commands are safe — they
serialise on a lock and a blocked one says so rather than corrupting anything —
but a long-running import will make a simultaneous brief wait a moment.

## When something looks wrong

| Symptom | First check |
|---|---|
| Brief looks suspiciously thin | `ai-ea fetch-status` — a stale feed and an empty one look identical |
| A fetcher keeps failing | The error is in `fetch-status`. It backs off, it is never given up on |
| A dropped statement was not imported | It is still in the folder; imported ones move to `imported/` |
| Reconciliation coverage dropped | Did the statement import cover the whole period? Imports are incremental by design |
| A category you set has reverted | It cannot. Check you are looking at the right entity's records |
| Everything is being escalated | `ai-ea readiness` — the profile is probably incomplete |
| "another process is writing" | A command is mid-write. Retry; if nothing is running, remove `.workspace.lock` |
