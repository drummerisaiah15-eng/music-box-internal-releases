---
description: Bring the finance file to tax-ready and produce the CPA packet
---

Get the finance records to tax-ready for: $ARGUMENTS (year and entity).

Follow the `finance-admin` skill. You organise records; you do not determine
deductibility.

1. `virtual-ea audit-files` over the archive. Fix anything misfiled; the engine
   gives you the correct path for each.
2. `virtual-ea reconcile`. Every unreceipted charge is either found, or
   confirmed personal, or listed as an open question. Look at everything marked
   `needs-eyes` yourself.
3. `virtual-ea cpa-packet --year <year> --entity <code>`.
4. If it reports `not ready to send`, work the open questions and run it again.
   Batch what you need from the principal into one message, not six.
5. Send the packet with its gaps visible, leading with what is unresolved and
   what you need for each.
