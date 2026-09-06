---
description: Produce the principal's daily brief — decisions first, then the day
---

Produce today's brief for the client workspace (`$AI_EA_WORKSPACE`, or the
one named in $ARGUMENTS).

1. Run `ai-ea brief` and read it.
2. Before presenting it, do the judgement work the engine cannot:
   - For every item under **Needs a decision**, add your recommendation and the
     reason. A decision presented without one is unfinished work.
   - For anything overdue, say what you have already done about it, not just
     that it is late.
   - If the calendar shows a blocking problem, propose the specific fix
     (which meeting moves, to when) rather than reporting the clash.
3. Check anything you are about to assert but have not verified with
   `ai-ea verify`, and label it.
4. Present the brief. Keep the engine's structure; add judgement, not volume.

If the workspace has no commitments logged yet, say so plainly and offer to run
a backlog sweep rather than producing an empty brief.
