---
name: project-coordination
description: Keep projects moving — timelines, next actions, vendor and staff follow-up, and documentation. Use when asked to track a project, chase people, build a timeline, run a vendor, or write up where something stands.
---

# Project coordination

Projects do not fail because nobody knew what to do. They fail because the
person who owed the next thing went quiet and nobody noticed for eleven days.
Your job is to be the thing that notices.

## Every project reduces to a list of owed items

Not tasks — *owed items*, each with a named human and a date. "Get the permit"
is not trackable. "Marcus at Halvorsen sends the stamped drawings by the 12th"
is.

```
ai-ea add --json '{
  "id": "halvorsen-drawings",
  "title": "Stamped drawings for Studio B permit",
  "lane": "project",
  "priority": "high",
  "status": "waiting",
  "waitingOn": "Marcus at Halvorsen",
  "source": "call 8/25 — Marcus committed to the 12th",
  "dueAt": "2026-09-12T21:00:00Z"
}'
```

Once logged, the chase schedule runs on its own. `ai-ea followups` tells
you who to chase and when chasing has stopped working.

## Chasing well

- **First chase:** short, friendly, assumes it slipped. Restate the ask and the
  date. Attach whatever they need so there is no excuse to delay.
- **Second chase:** name the consequence. "The permit window closes the 19th, so
  I need these by Thursday to keep that." Copy nobody new yet.
- **Then escalate,** which means bringing it to the principal, not shouting. The
  engine flags this automatically. The brief asks them a real question: push, or
  drop it and find another route?

Log every chase (`ai-ea event --json '{"type":"nudged","commitmentId":"..."}'`).
The count is what turns "Marcus is slow" from an impression into a fact you can
act on.

## Timelines

Build backwards from the fixed date, and identify the one thing that determines
everything else. State the critical path explicitly:

> Opening is the 30th. Working back: inspection needs 5 working days, which
> needs the permit by the 19th, which needs Halvorsen's stamped drawings by the
> 12th. Everything else has slack. The drawings are the whole timeline.

Then say what happens if it slips, before it slips.

## Documentation

Write the record while it is cheap. After any decision or vendor call:

- What was decided, by whom, on what date.
- What was rejected and the reason — this is what stops the same debate in six
  weeks.
- Who owes what next, which goes straight into the ledger.

Keep it in the client's system of record. If a decision only exists in a Slack
thread, it does not exist.

## Status reporting

Four headings, in this order, every time:

**Shipped** — done since last report.
**In flight** — moving, with the next checkpoint.
**Blocked** — what is stuck, on whom, since when, and what you have already
tried.
**Needs you** — the decisions only the principal can make.

If "Needs you" is empty, say so explicitly. Silence there reads as an oversight.
