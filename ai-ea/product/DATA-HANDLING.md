# Data handling

Client-facing. A client is handing over their inbox, calendar and financial
records. This is the document that decides whether they do.

## What is held, and where

The engine stores everything in a **plain directory on infrastructure you
control**. One workspace per client:

```
<workspace>/
  client.json      profile, authority limits, voice
  ledger.jsonl     append-only commitment log
  documents.json   document metadata (not the documents)
  statements.json  statement lines under reconciliation
  calendar.json    the working day
  approvals.json   what is waiting on the principal
```

There is no vendor database, no hosted account, and no telemetry. Nothing is
transmitted anywhere by the engine itself. Deleting the directory ends the
retention question completely.

Source documents — the actual receipts and statements — stay in the client's own
storage. The engine records metadata and paths, not copies.

## Separation between clients

One directory per client, never shared, never merged. No client's data is used
to inform work for another. Where an assistant works across several clients,
each session is scoped to a single workspace.

## Access

Granted by delegated access, an administrator connection, or a shared password
manager. **Credentials are never accepted over email or chat.** If that is the
only route offered, we decline and propose an alternative in the same message.

Read-only is requested wherever read-only suffices — finance accounts in
particular are read access for reconciliation, not transaction authority.

What was granted is recorded in the profile and confirmed in writing at
onboarding. That confirmation is the document that settles any later question
about scope.

## What cannot happen, structurally

Enforced in code, not by policy:

- **No signing.** Refused for every configuration.
- **No record deletion.** Refused for every configuration.
- **No outbound action without an authority check.** Unrecognised actions
  default to asking, never to proceeding.
- **No silent widening of authority.** Limits change only by an explicit
  decision recorded in the profile.

The ledger is append-only. History is corrected by adding a correcting event,
never by editing the past, so any later question about who changed a due date
and when has an answer.

## Sensitive material

Topics on the client's sensitive list route to the principal even when the
recipient is allowlisted. The default list covers legal, litigation, IRS and tax
notices, terminations, investors and acquisitions, and is extended per client.

## AI processing

An AI assistant reads the material it is asked to act on. Two limits on that:

**Judgement only.** Anything a client would be upset to have wrong — amounts,
dates, ordering, reconciliation, authority decisions — is computed by tested
code, not estimated by a model. The model drafts, classifies and explains; the
engine decides.

**No training.** Client material is not used to train models. Where the
underlying provider offers a zero-retention or no-training configuration, it is
used, and which provider and configuration is in use is disclosed on request.

## Retention and exit

Records are retained for as long as the engagement runs plus the period the
client specifies — commonly seven years for anything tax-related, since these
are the client's business records.

At exit, the client receives the entire workspace as plain files: JSON and JSONL
they can open in any text editor, plus their documents in their own storage
under a documented naming convention. No export process, no proprietary format,
no lock-in. Anything held on our side is then deleted, confirmed in writing.

## Incidents

If material is exposed, sent to the wrong recipient, or accessed improperly, the
client is told the same day, with what happened, what is affected, and what has
already been done about it. Before we have finished investigating, not after.
