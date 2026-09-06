---
name: inbox-triage
description: Triage an executive inbox into decisions, commitments and noise, and draft replies in the principal's voice. Use when asked to go through email, clear an inbox, catch up on messages, find what needs a reply, or draft correspondence on someone's behalf.
---

# Inbox triage

The goal is not an empty inbox. It is that every obligation buried in it is now
in the ledger with an owner and a clock, and that the principal reads only the
few things that genuinely need them.

## The pass

Work newest-first, and put every message into exactly one of five buckets.

**1. Needs the principal** — a decision only they can make, a relationship only
they hold, or anything on the escalation list. Extract the actual question,
draft your recommended answer, and put it in the brief. Never forward a thread
and ask them to read it.

**2. Mine to handle** — log it, then do it. Scheduling, document requests,
routine vendor back-and-forth, information the principal already decided.

**3. Waiting on someone** — log with `status: "waiting"` and `waitingOn` naming
the actual human, not the company. The chase schedule then runs itself.

**4. Reference** — no action, but it will be wanted later. File it per the
naming convention (see `finance-admin` for anything with a dollar amount).

**5. Noise** — archive. Do not report a count of newsletters as work done.

## Extracting the commitment

Most obligations are implied rather than stated. "Let's circle back after the
15th" is a commitment with a date. Log what was actually promised:

```
ai-ea add --json '{
  "id": "w9-sweetwater",
  "title": "Send signed W-9 to Sweetwater AP",
  "lane": "finance",
  "priority": "high",
  "source": "email:thread-882 — Dana promised it Friday",
  "dueAt": "2026-09-12T21:00:00Z"
}'
```

`source` must let anyone reconstruct why this obligation exists, months later,
without your memory. A thread id and a one-line quote is the standard.

## Drafting

Match the principal's register from their `client.json` voice profile and from
their actual sent mail — read three or four of their real replies to the same
person before writing as them.

- Reply at the length the message deserves, which is usually shorter than the
  incoming one.
- Answer the question in the first sentence.
- Never invent a commitment on their behalf. If a date is needed and you do not
  have one, propose one and flag it in the brief rather than promising.
- Anything sensitive, unusual, or to someone on the review-first list goes
  through `ai-ea authority` before it sends, and is drafted complete.

## Handing it back

Report the pass as counts plus what changed, never as a list of everything you
read:

> 41 messages. 3 need you (in the brief), 12 logged and handled, 4 now waiting
> on named people, rest filed or archived. One thing worth flagging: Halvorsen's
> AP contact changed, so the invoice we chased last week went to a dead address.
> Resent to the new one and logged it.
