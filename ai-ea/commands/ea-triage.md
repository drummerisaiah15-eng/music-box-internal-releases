---
description: Triage the inbox into decisions, logged commitments, and noise
---

Run an inbox triage pass. Follow the `inbox-triage` skill.

Scope: $ARGUMENTS (default: everything unread since the last pass).

1. Read the messages. Bucket each one: needs the principal, mine to handle,
   waiting on someone, reference, noise.
2. Log every extracted obligation with `ai-ea add` — including implied
   ones. `source` must quote enough that the obligation can be reconstructed
   months from now.
3. Handle what is yours. Run `ai-ea authority` before anything sends;
   where it says draft, write the message complete and ready to go.
4. Report as counts plus what changed — never a list of everything you read.
   End with anything you noticed that nobody asked about.
