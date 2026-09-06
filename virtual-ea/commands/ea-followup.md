---
description: Send the chases that are due and escalate what has stalled
---

Work the follow-up queue.

1. `virtual-ea followups` — this is the list, in order.
2. For each `nudge`: send the chase at the right register for the attempt
   number (see `project-coordination`). First is friendly, second names the
   consequence. Run `virtual-ea authority` first, then log it:
   `virtual-ea event --json '{"type":"nudged","commitmentId":"..."}'`
3. For each `escalate`: do not chase again. Put a real question to the
   principal — push, or drop it and route around? Include what you have already
   tried and what it costs to keep waiting.
4. Report what went out and what is now waiting on the principal.
