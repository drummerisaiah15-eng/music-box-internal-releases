---
name: finance-admin
description: Finance administration and tax-ready record keeping — receipts, statements, folder structure, naming conventions, expense categorisation, reconciliation, and CPA request packets. Use when asked to file receipts, organise financial records, chase down missing documentation, prepare for taxes, or answer a CPA's request.
---

# Finance administration

Records are tax-ready when a CPA can answer any question from the file without
calling you, and when every dollar that left the account has a document behind
it. Both are mechanical properties. Neither is achieved by a tidy-looking
folder.

**Scope:** you organise, classify and reconcile. You do not determine
deductibility and you do not give tax advice. Category and Schedule C
references are proposals that speed up the CPA's work, labelled as such every
time they leave your hands.

## Filing

Never name a file by hand. Every document goes through the engine, which
produces a name that can be parsed back into its own metadata:

```
virtual-ea file --json '{
  "date": "2026-03-14", "entity": "MBX", "docType": "RECEIPT",
  "counterparty": "Sweetwater Sound, Inc.", "amountCents": "$1,284.99",
  "reference": "INV-10233", "extension": "pdf"
}'
→ Finance/2026/MBX/02_Receipts/2026-03-14__MBX__RECEIPT__Sweetwater-Sound-Inc__USD1284-99__INV-10233.pdf
```

This matters more than it looks. The convention folds vendor spellings together,
so "Sweetwater Sound, Inc." and "sweetwater sound inc" cannot end up as two
vendors with split year-end totals. Tax year sits above entity in the path, so
"send the CPA everything for 2025" is a folder copy rather than a project.

To check an archive someone else built: `virtual-ea audit-files`. It reports
files in the wrong folder for their own metadata, names that break the
convention, and probable duplicates — one line each, all of them, in one pass.

## Entities

Personal and business records never share a folder. If the principal has one
card for both, split at filing time using the `entity` field and category
`personal`, and keep those rows visible in the file rather than deleting them.
An excluded charge that is visible is auditable; one that was quietly removed
is not.

## Reconciliation is the real work

Totals are already in the accounting software. What is not there — and what
costs money in an audit — is the list of charges with no document behind them.

```
virtual-ea reconcile
→ Matched 34/37 lines (94% of dollars).
  Unreceipted exposure: $1,847.20.
  - 2026-03-09 DELTA AIR 0062199 $612.40
```

Run it weekly, not in April. The engine matches on exact cents within a posting
window and handles the mangling payment processors do to vendor names, but it
will never match on a near-miss amount: one cent out is a different
transaction, and a wrong match is worse than an obvious gap because the gap
gets investigated.

Anything it flags as `needs-eyes` matched on amount and date but not on name.
Look at those yourself.

## Substantiation

Some categories fail on missing context rather than missing paper. `virtual-ea`
flags these as blocking:

- **Meals** — needs attendees and business purpose, not just the receipt.
- **Travel and vehicle** — needs the business purpose recorded at the time.
- **Anything uncategorised** — needs the principal to say what it was for.

Ask for these in a weekly batch while the answers are still recoverable, not at
year end when "dinner, March" is unanswerable.

## The CPA packet

```
virtual-ea cpa-packet --year 2025 --entity MBX
```

Produces totals by category with suggested Schedule C lines, the reconciliation
position, and — the part that matters — its own list of open questions. Send it
with the gaps visible. A packet that hides what is missing costs a billable hour
and a round trip; one that leads with "here are the four things I could not
resolve and what I need for each" gets answered in one.

When it reports `not ready to send`, it is not ready to send. Work the open
questions first.

## Answering a CPA request

Give them the document, not a description of it. "Attached: the 2025 equipment
receipts, 14 files, $18,204.11 total, reconciled to the card statement with no
gaps" beats a paragraph of explanation. If something is genuinely missing, say
so in the first line and say what you are doing about it.
