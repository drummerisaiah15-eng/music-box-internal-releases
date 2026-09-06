---
name: client-onboarding
description: Onboard a new principal or client onto the virtual EA — set up their workspace, capture authority limits, connect systems, and reach operational state in the first week. Use when starting with a new client, setting up a workspace, configuring what the assistant may do without asking, or when a readiness check reports gaps.
---

# Client onboarding

The engagement is won or lost in week one. A half-configured assistant asks
about everything, which is exactly the experience the client hired someone to
escape.

Target: **operational by day three**, meaning routine work happens without
interruption and only genuine decisions reach the principal.

## Day one — stand up the workspace

```
virtual-ea init --workspace ~/clients/acme --client acme
```

Then fill in `client.json` from the kickoff call and check yourself:

```
virtual-ea readiness --workspace ~/clients/acme
```

It reports what is still unanswered, what each gap will cost in daily friction,
and the exact question to ask. Work it to `operational: true`. Do not start
executing from a half-filled profile — you will train the client to expect
interruptions and then have to untrain them.

## The questions that actually matter

Most onboarding questionnaires ask forty things and miss the five that
determine whether this works.

**1. What can I spend without asking?** A number. `spendApprovalCents`. Without
it every purchase interrupts them, which is the opposite of the job.

**2. Who can I email directly?** Domains, not people. `autoSendDomains`. Then
the inverse: who must always be drafted first — counsel, investors, the IRS,
specific difficult counterparties. `neverAutoSend`.

**3. What are your entities?** Every legal entity plus a personal bucket. Get
this wrong and personal charges land in the business file and have to be
unpicked at year end.

**4. What does urgent mean to you?** Default SLAs are 4 hours to acknowledge on
high priority. Some principals need one. Set `slaOverrides` rather than
discovering the mismatch during a real incident.

**5. Show me five emails you have sent.** Not a description of their tone — the
actual sent mail. Read it before drafting anything as them.

Also worth capturing early: what they do not want to see, what their last
assistant got wrong, and which recurring thing annoys them most. That last one
is usually the first SOP.

## Access

Ask for the minimum that lets you execute rather than only draft: inbox,
calendar, file storage, and read access to the finance accounts. Read-only where
read-only will do.

Record what was granted in `connectedSystems` and confirm in writing what you
have access to and what you do not. That message is worth keeping — it is the
document that settles any later question about scope.

Never accept credentials over email or chat. Delegated access, a password
manager, or an admin-granted connection. If a client offers to send a password,
decline and give them the alternative in the same message.

## First week rhythm

- **Day 1** — workspace, profile, access. Log every commitment from the kickoff
  call before it evaporates.
- **Day 2** — backlog sweep. Everything already owed, into the ledger. Expect to
  find things nobody was tracking; report them without drama.
- **Day 3** — first daily brief. Ask, once, whether the shape is right.
- **Day 5** — first reconciliation, however ugly. The number establishes the
  baseline you will improve.
- **Day 7** — first weekly summary: shipped, in flight, blocked, needs you. Plus
  one thing you noticed that they did not ask about.

## Setting expectations honestly

Say plainly what you do not do: no signing, no record deletion, no tax or legal
advice, and nothing outside the authority model. Clients trust the boundaries
more than the promises, and the boundaries are enforced in code rather than
goodwill — which is a thing worth telling them.
