---
name: sop-builder
description: Turn repeated work into written SOPs and automated workflows so throughput rises without headcount. Use when the same task has come up several times, when documenting a process, when handing work to someone else, or when asked to make something repeatable or automated.
---

# Systems and SOPs

The third time you do something by hand, you are the bottleneck. Write it down
or automate it.

## What earns an SOP

Not everything. An SOP has a maintenance cost, and a stale SOP is worse than
none because someone will follow it.

Write one when the task is **repeated**, **consequential if done wrong**, and
**stable** — the steps will not change next month. Monthly vendor reconciliation
qualifies. "How Dana likes their coffee" does not.

## The format

One page. If it does not fit, it is two SOPs.

```
PURPOSE — one sentence: what this produces and who needs it.
TRIGGER — what starts it (a date, an event, a request).
OWNER — the role, not the person.

STEPS — numbered, imperative, each one verifiable.
  Include the actual command or the actual click path. Not "file the receipt"
  but `virtual-ea file --json '{...}'`.

DONE WHEN — the observable condition. Not "receipts are filed" but
  "virtual-ea reconcile reports 100% dollar coverage for the month".

WHEN IT GOES WRONG — the two or three failures that actually happen, and what
  to do about each.

LAST REVIEWED — a date. An SOP with no review date is a rumour.
```

A step someone can perform differently on two occasions is not written finely
enough. "Categorise the expense" is a judgement call; "categorise per the
category table in `finance-admin`, and mark anything ambiguous
`uncategorised` rather than guessing" is a step.

## Automating instead

Before writing an SOP, ask whether the step should exist at all. In order of
preference:

1. **Delete it.** Most recurring work is a workaround for something upstream.
2. **Make it structural.** A naming convention enforced at filing time beats a
   monthly clean-up. A logged commitment with a due date beats a recurring
   reminder to check whether anyone replied.
3. **Automate it.** The `virtual-ea` CLI is scriptable and deterministic — a
   cron job can produce the brief, run the reconciliation, and mail the result.
4. **Then** write the SOP for what is left.

## Using AI inside a workflow

Be specific about where a model is trustworthy. It is good at drafting,
classifying, summarising and extracting. It is not the right tool for
arithmetic, dates, ordering, or anything the principal would be upset to have
wrong — those go through the engine, which is tested and produces the same
answer twice.

A workflow that says "the assistant checks the totals" is a workflow with a
silent failure mode. One that says "run `virtual-ea reconcile`, then explain
anything it flags as needs-eyes" puts the judgement and the arithmetic in the
right places.

## Keeping them alive

Review an SOP when it is used and something did not match, and on a fixed
cadence otherwise. Delete ones nobody follows — an SOP library that is 60%
accurate teaches people to ignore all of it.
