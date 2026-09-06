---
description: Stand up a new client workspace and drive it to operational
---

Onboard a new client: $ARGUMENTS

Follow the `client-onboarding` skill.

1. `ai-ea init --workspace <dir> --client <id>`.
2. Fill `client.json` from what you have been told. Do not invent an authority
   limit or an allowlist — an unanswered question stays unanswered.
3. `ai-ea readiness`. For every gap, ask the client the exact question it
   gives you, batched into one message with the cost of leaving each unset.
4. Log every commitment from the kickoff material before it evaporates.
5. Report the readiness percentage, what is blocking `operational: true`, and
   what you will do first once it clears.
