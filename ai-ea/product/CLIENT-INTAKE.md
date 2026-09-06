# Client intake

Send before the kickoff call. It takes about fifteen minutes. Everything here
maps directly to a field in the client profile, and every unanswered question
becomes an interruption later.

## The five that decide whether this works

**1. What can I spend without asking?**
A dollar amount. Below it I act; above it I bring you a recommendation and wait.
Leaving this blank means every purchase interrupts you.
→ `spendApprovalCents`

**2. Which domains can I email directly?**
Domains, not individuals — your own company, regular vendors, anyone routine.
→ `autoSendDomains`

**3. Who must always come to you first?**
Counsel, accountant, investors, board, specific difficult counterparties.
This overrides the allowlist above.
→ `neverAutoSend`

**4. What are your legal entities?**
Every business entity, plus a personal bucket. Records never share a folder
across entities, and getting this wrong means unpicking it at year end.
→ `entities`

**5. Can you forward five emails you have actually sent?**
Not a description of your tone. The real thing, ideally including one where you
said no to someone.
→ `voice`

## Working pattern

- Working days and hours, and your timezone.
- Quiet hours — when a message should never land.
- Time that is protected by default and needs a decision to break.
- How you prefer to be reached when something cannot wait for the brief.

## Urgency

Default is: high-priority items acknowledged within 4 hours, resolved or
escalated within 2 business days. Is that right for your world, or should it be
tighter? Tell us where the defaults would have failed you in the last month.
→ `slaOverrides`

## Systems

What will I have access to, and at what level?

- Email —
- Calendar —
- File storage —
- Finance accounts (read-only is usually enough) —
- Project or task system —
- Anything else —

Access is granted by delegation, an admin connection, or a password manager.
Credentials are never accepted over email or chat; if that is the only route
available, say so and we will find another.
→ `connectedSystems`

## The state of things

- What is currently being dropped that shouldn't be?
- What did your last assistant get wrong?
- Which recurring task annoys you most? (This becomes the first SOP.)
- Is there anything in your inbox or files that I should not open?
- Who are the three people whose messages always matter?

## Finance starting position

- Who prepares your taxes, and how do they like to receive things?
- Are personal and business genuinely separate today, or mixed on one card?
- Where do receipts currently live?
- When is the last period that was fully reconciled?

An honest answer of "nowhere" and "never" is more useful than an optimistic one.
The first reconciliation establishes a baseline; it is not a test.
