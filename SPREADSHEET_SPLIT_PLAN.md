# One document per spreadsheet project (MB161-012)

Status: **stage 1 of 3 complete.** The storage model, the index, and the rules
are in and tested. Nothing calls them yet, so the running app is unchanged.

---

## Why

The whole workbook — every project, every sheet — was one encrypted Firestore
document. Firestore caps a document at 1 MiB on every plan; the quotas page
lists it under "These are hard limits unless otherwise noted" with no billing
qualifier, and unlike composite indexes and databases-per-project it carries no
"contact support to request an increase" link. Upgrading the Firebase plan does
not move it.

At roughly 66 bytes per filled cell that gave the entire studio about 9,000
cells — one mostly-filled 200×30 schedule is already two thirds of it.

The same page shows the way out: Firestore limits document **size**, not
documents per collection, and subcollections nest 100 deep. Moving from one
document per workbook to one per project applies the budget to each project
instead. Same plan, same cost, no quota request.

**~9,000 filled cells per project**, across up to 25 projects.

---

## Shape

| Key | Holds |
|---|---|
| `spreadsheets` | the index: which projects exist, which one is open |
| `spreadsheet_<projectId>` | one project: name, sheets, cells, attribution, conflicts |

The index is a tombstoned record list, the same structure logs already use, so a
project created on one Mac and deleted on the other merges by rules that are
already proven and absence never means deletion.

A project document is stored and merged **as a one-project workbook**. That is
not cosmetic: `_deriveSpreadsheetOperations`, `_applySpreadsheetOperations`,
`_mergeSpreadsheetEdits`, the conflict model and `normalizeSpreadsheetWorkbook`
are reused unchanged rather than a second merge being written for the same data.
`normalizeSpreadsheetProject` is literally the workbook normalizer with an
adapter on each end.

---

## Stage 1 — storage model *(done)*

- `_ssProjectSyncKey` / `_ssIsProjectSyncKey` / `_ssProjectIdFromSyncKey`
- `normalizeSpreadsheetIndex`, `normalizeSpreadsheetProject`
- `_ssSplitWorkbook` / `_ssAssembleWorkbook` — pure; they decide what to write
- `_ssIsLegacyWorkbook` — tells an old workbook from an index
- `getSyncKeys()` / `isSyncKey()` now include project keys
- `firestore.rules` admits `spreadsheet_[A-Za-z0-9_-]{1,100}`, still undeletable

25 tests in `tests/spreadsheet-split.test.js`.

## Stage 2 — wiring *(next)*

- `ssLoad` assembles `_ssData` from the index plus loaded project documents
- the save path splits `_ssData` and writes only the projects that changed
- `SYNC_MERGE_STRATEGIES` gains `spreadsheet-index`; project keys reuse
  `spreadsheet-operations`
- `_refreshForSyncKey` handles a project key arriving on its own
- capacity (MB161-011) becomes per project
- presence and attribution follow the project document

## Stage 3 — migration

- on load, if `spreadsheets` is a legacy workbook, split it and write the
  documents before the index, so a Mac that sees the new index always finds the
  content behind it
- idempotent, and safe when both Macs attempt it — each key is CAS'd
  independently and the merge converges
- **both Macs must be on the new build before the rules are deployed.** An older
  build reading the new index fails normalization, which quarantines the key and
  preserves local data rather than overwriting — safe, but it stops syncing
  until it is updated.

---

## Not yet true

- Nothing calls any of stage 1. The app still reads and writes one document.
- No migration has been written or run.
- The per-project ceiling is enforced by `normalizeSpreadsheetProject`, which
  nothing calls yet; the live limit is still workbook-wide.
- None of this has been exercised on two Macs.
