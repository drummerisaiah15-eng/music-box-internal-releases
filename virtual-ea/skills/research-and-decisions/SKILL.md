---
name: research-and-decisions
description: Research options, verify claims, and produce a recommendation with a stated confidence level. Use when asked to compare vendors or products, check whether something is true, look into a company or person, evaluate a proposal, or decide between options.
---

# Research and decision support

A summary of what the internet says is not the deliverable. The deliverable is a
recommendation the principal can act on, with the established parts separated
from the merely repeated parts, and an honest statement of what would change
the answer.

## Verify before you write

Anything load-bearing goes through the engine, which grades claims on source
tier and independence:

```
virtual-ea verify --json '{
  "claim": "Vendor A is SOC 2 Type II certified",
  "kind": "technical",
  "sources": [
    {"kind":"vendor","publisher":"Vendor A website","retrievedOn":"2026-09-01"}
  ]
}'
→ [UNVERIFIED] Only vendor marketing supports this.
  To settle: Treat as a lead, not a fact, until a tier 1–3 source confirms it.
```

Two things the engine enforces that are easy to get wrong by hand:

**Syndication is not corroboration.** Six outlets running the same wire story
are one source. Set `origin` when several publishers share an upstream, and the
count reflects reality.

**A credible contradiction beats any amount of agreement.** Four blogs agreeing
lose to one official source disagreeing. Surface the conflict; never quietly
take the majority.

Freshness is enforced by claim type — pricing goes stale in 90 days, statute in
a year. A price you confirmed in January is not confirmed today.

## Comparing options

Score the options, then attack your own result:

```
virtual-ea decide --json '{
  "question": "Which payroll provider?",
  "criteria": [
    {"id":"cost","label":"Cost","weight":3,"lowerIsBetter":true},
    {"id":"support","label":"Support quality","weight":4},
    {"id":"integration","label":"Integrations","weight":2}
  ],
  "options": [
    {"id":"Gusto","scores":{"cost":6,"support":8,"integration":7}},
    {"id":"Rippling","scores":{"cost":8,"support":7,"integration":9}}
  ]
}'
```

A weighted matrix always produces a winner, so the winner is not the
interesting output. The engine re-runs the ranking with each criterion's weight
halved and doubled, and tells you whether the answer survives someone
disagreeing with the weights. When it does not, say so — "leading candidate,
not a decision" is a legitimate and useful conclusion, and pretending otherwise
is how a recommendation gets quietly reversed a week later.

If the winner rests on an unverified claim, the engine flags that too. Settle it
before recommending, or state plainly that the recommendation is contingent.

## Writing the brief

Length is set by the decision, not by how much you found. Most fit on one
screen.

```
RECOMMENDATION — one sentence, the actual answer.

WHY — three bullets maximum. The reasons that would survive being challenged.

CONFIDENCE — high / moderate / low, and what makes it that.

WHAT WOULD CHANGE THIS — the specific fact or price that flips the answer.

WHAT I COULD NOT CONFIRM — every unverified load-bearing claim, named.

SOURCES — publisher, tier, date retrieved, link.
```

The last two sections are not hedging; they are the reason the first one is
worth reading. Never bury an unverified input in paragraph six — a principal
who is particular about accuracy will find it, and every future
recommendation gets discounted.

## Watch for

- **Vendor claims restated by trade press.** Still the vendor's claim.
- **Review sites with affiliate relationships.** Tier 6, not tier 3.
- **A number that appears everywhere with no primary source.** Usually one bad
  study. Find the study.
- **Comparisons published by one of the options.** Read them, cite them as
  vendor material, never as analysis.
- **Your own summary drifting from the source.** Quote the load-bearing line
  rather than paraphrasing it.
