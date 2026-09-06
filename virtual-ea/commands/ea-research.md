---
description: Research a question and return a recommendation with stated confidence
---

Research this and come back with a recommendation, not a summary: $ARGUMENTS

Follow the `research-and-decisions` skill.

1. Establish what would actually settle the question, then go and find it.
   Prefer primary and official sources; treat vendor material as a claim.
2. Run every load-bearing claim through `virtual-ea verify`. Set `origin` where
   several publishers share an upstream, so syndication does not read as
   corroboration.
3. If this is a choice between options, run `virtual-ea decide` and report
   whether the winner survives reweighting. If it does not, say so.
4. Write it in the brief format: recommendation, why, confidence, what would
   change this, what you could not confirm, sources.

Do not pad it. If the answer is one line with two sources, that is the brief.
