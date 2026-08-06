# One document per spreadsheet project (MB161-012)

Status: **all three stages written and unit-tested. Never run on a real Mac.**
The next step is behavioural: install on two machines and watch it migrate.

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

## Stage 2 — wiring *(done)*

- `_syncMergeStrategy(key)` replaces the frozen lookup, since project keys are
  dynamic. `spreadsheets` keeps the **operation** merge while it still holds a
  legacy workbook, so a Mac mid-migration is never stranded with an unmergeable
  key
- `_ssIndexAfterEdit` decides when absence means deletion — see below
- `ssLoad` assembles from the index plus project documents
- the save path commits each changed project to its own document, then the
  index only if the set of projects actually changed
- `_refreshForSyncKey` fires for a project document arriving on its own key and
  rebuilds from storage rather than from the one value that arrived

## Stage 3 — migration *(done)*

`_ssMigrateToSplitStorage()` runs once, from `ssLoad`, when the stored shape is
a legacy workbook. Every project document is written **first** and the index
**last**, so a failure part-way leaves the old single document authoritative —
`_ssStorageMode` still reports `legacy` until the index lands. A failure
re-arms the migration and says the data is unchanged.

It refuses to run while `_ssAwaitingAuthority` or `_ssBlockedWorkbook` is set:
migrating a workbook this Mac invented would publish it as real, per project.

---

## The rule that matters most

`_ssIndexAfterEdit` derives the index from what **changed** between the
workbook the session started from and the one it ends with:

| | |
|---|---|
| in the result, not in the index | new project — added |
| in the base, not in the result | somebody deleted it — tombstoned |
| in the index but in **neither** | untouched, whatever its state |

That last row is the whole design. A project whose document has not finished
downloading is absent from `_ssData`; building the index from `_ssData` would
tombstone it, and the tombstone would sync and delete the project off the other
Mac. Deletion has to be an act somebody performed, never an inference from
absence.

---

## Not yet true

- **None of this has run on a real Mac.** Every test is a unit test against a
  stubbed store; no migration has touched real localStorage or Firestore.
- The two-Mac behavioural matrix has not been run — and it now has more to
  cover: migration on one Mac while the other is on the old build, migration on
  both at once, a project document arriving before the index, and a project
  deleted on one Mac while open on the other.
- **Both Macs must be on this build before the rules are deployed.** An older
  build reading the new index fails normalization, which quarantines the key
  and preserves local data rather than overwriting — safe, but it stops syncing
  until it is updated.
- Capacity (MB161-011) still measures the assembled whole workbook, so it warns
  against the old shared budget rather than the new per-project one. It is now
  pessimistic rather than wrong, but it should be made per-project.
- Presence and attribution have not been revisited; they ride inside the
  project document and should be fine, but that is reasoning, not evidence.
