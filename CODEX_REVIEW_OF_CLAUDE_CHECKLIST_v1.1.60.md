# Music Box Internal — Independent Review of Claude's pre-v1.1.60 Checklist

Date: 2026-07-30  
Reviewed source: uncommitted working tree above `08e00eed70099fc3a0de3dce4e7ec5a16b0e0eea`  
Application version in source and unsigned package: `1.1.59`  
Review mode: read-only application audit; no Firebase or iCloud production data touched; no application fixes, commits, tags, notarization, or publication

## Verdict

**DO NOT RELEASE.**

Claude's top-level `NOT RELEASABLE` verdict is correct, and several of its new safety mechanisms are real improvements. The checklist is nevertheless not an accurate account of the current candidate. Multiple items marked fixed are only partially fixed, several stated guarantees fail in deterministic current-source reproductions, and the claimed authoritative save-debt test misses production write paths.

The most important release blockers are:

1. The updater save gate can acknowledge `ok: true` after the renderer explicitly returns `false`.
2. True two-device concurrent log additions and different-cell spreadsheet edits are not merged. They become whole-document conflicts, and one resolution direction can overwrite the other device's active copy without automatically preserving that cloud copy.
3. Quarantine Retry does not run the poisoned-pending classifier. A revision-zero pending value can be released against a repaired legacy remote.
4. The spreadsheet authority hold has broken transition/UI paths and can remain stuck on `Checking the cloud`.
5. `STORE_SET_DEBT` is not authoritative. It misses synchronized computed-key and helper-backed `STORE.set()` paths.
6. Live snapshot failures are neither durably quarantined nor recorded in the per-key status model and can later be displayed as synced.
7. Recovery export can write plaintext while the checklist says it never does, and malformed plaintext-like remotes can be mislabeled as encrypted.

## Evidence summary

| Check | Result |
|---|---|
| Git base | `08e00eed7009` |
| Tracked source changes | `index.html`, `tests/sync-persistence.test.js` |
| `git diff --check` | Pass |
| Automated suite | **137/137 pass**, not 121/121 |
| HEAD baseline | 99 tests |
| Net tests added | 38, not 16 |
| Unsigned local package | Pass |
| Packaged renderer hash | Exact match to working-tree `index.html` |
| Packaged/source version | `1.1.59` |
| Production dependency audit | 0 vulnerabilities |
| Full dependency audit | 16 high-severity findings in development/build dependency chains |
| Live two-Mac/Firebase test | Not run; no staging Firebase credentials/environment were provided |
| Signed/notarized/release artifact | Not built; this is not versioned release source |

The full audit's 16 high findings are in build/development dependencies rooted through `electron-builder` tooling. They do not appear in `npm audit --omit=dev`, which reports zero. No automatic audit fix was run.

## Corrected status table

| ID | Claude status | Independent status |
|---|---|---|
| V159-001 | Fixed | **Partial** — default writes are gated, but authority transitions/UI release are broken |
| V159-002 | Primitive fixed; logs converted | **Partial** — one in-renderer ordering is fixed; true two-device concurrency and many production write paths remain unsafe |
| V159-003 / V160-008 | Fixed, fail-closed | **Not fixed** — preload turns callback `false` into `ok: true`; live failures are not durable per-key failures |
| V159-009 | Fixed, durable | **Partial** — bootstrap quarantine persists normally, but live failures, UI refresh, and persistence-failure behavior remain incomplete |
| V160-001 | 20 unsafe key families remain | **Understated** — at least 22 synchronized families and additional helper/computed call paths remain |
| V160-002 | Fixed | **Partial** — the write chokepoint works, but real transition paths can stay blocked or visibly stuck |
| V160-003 | Fixed | **Partial** — bootstrap hold works; quarantine Retry can bypass it |
| V160-004 | Different-cell case fixed | **Order-dependent only** — remote-first passes; local-first/two-device concurrency does not merge |
| V160-005 | Open | **Open**, as reported |
| V160-006 | Fixed | **Partial** — remote validation was added, but Retry can release an unclassified revision-zero pending value |
| V160-007 | Fixed | **Partial** — v2 record capture is fixed, but plaintext/malformed/cancel handling is not |
| MB-008 | Regression tests added | **Verified at source/unit level** — navigation paths do not directly save |
| V159-004/005/006/007/008/010/011 | Open | **Open**, as reported |

## Release-blocking findings

### C-01 — Updater flush acknowledgement ignores an explicit failure

Severity: **Critical**

Claude marks V159-003/V160-008 fixed and says pending or quarantined data prevents update installation. The full renderer-to-main path does not uphold that guarantee.

Evidence:

- `index.html:13769-13789` registers the lifecycle callback.
- When Firebase is unavailable, that callback returns `false` if it finds a pending/corrupt record.
- `preload.js:121-131` awaits the callback but ignores its return value:

  ```js
  await callback();
  ok = true;
  ```

- `main.js:1042-1057` trusts that acknowledgement before calling `quitAndInstall`.

Independent execution of the real preload listener with `async () => false` sent:

```json
{"ok":true}
```

There is a second hole in the renderer callback: when disconnected it checks pending records only. A durable quarantine with no pending record returns `true` at `index.html:13780-13788`.

Consequences:

- Offline pending data can fail the renderer check yet still be acknowledged as safe to install.
- Offline/unbootstrapped quarantine without pending data is not considered unsafe.
- The checklist's §5.7 claim cannot pass as written.

Required correction and tests:

1. Preload must acknowledge success only when the callback resolves to exactly `true`.
2. The renderer's disconnected branch must fail closed for pending, corrupt, quarantined, recovery-required, failed, and unknown states.
3. Execute the real preload/main handshake in tests for callback `true`, `false`, and throw.
4. Test update installation while connected, offline, bootstrapping, quarantined-without-pending, recovery-held, and with corrupt pending metadata.

### C-02 — `STORE.mutate()` does not solve true two-device concurrency

Severity: **Critical**

The new primitive fixes this specific order:

1. remote reconciliation holds the local per-key lock;
2. the user queues a local mutation;
3. the remote value commits locally first;
4. the mutation derives from that newly reconciled base.

It does not merge two devices that both create pending writes before seeing the other's change.

#### Logs reproduction

Two device contexts started from the same revision and each added a different record:

```text
Device A pending: base + A
Device B pending: base + B
```

Using the production `syncPush` transaction:

1. A succeeded and advanced the remote revision.
2. B received `SYNC_CONFLICT`.
3. `Keep This Mac` then replaced the whole remote value with B's whole array.
4. The resulting active remote did not contain A.

Relevant source:

- Whole-document CAS/write: `index.html:4826-4853`
- Remote snapshots are skipped while local pending exists: `index.html:4988-5008`
- Use Cloud whole-copy resolver: `index.html:5613-5663`
- Keep This Mac whole-copy resolver: `index.html:5672-5711`

`_createSyncConflictBackup()` captures this Mac's local ciphertext at `index.html:5560-5573`. The Keep This Mac path does **not** automatically fetch and preserve the cloud copy before overwriting it. The optional `Export both copies first` action is not equivalent to automatic preservation.

Therefore these checklist expectations are not currently implemented:

- §5.2 different concurrent log additions both survive.
- §5.2 delete versus edit neither disappears.
- The broad claim that conflict resolution preserves both sides before either choice.

#### Spreadsheet reproduction

The new test at `tests/sync-persistence.test.js:226-350` starts remote reconciliation first and only then types locally. It proves one useful ordering, not general two-device behavior.

In the reverse/local-first order:

1. the local edit reserves the key chain while waiting on its debounce gate (`index.html:6685-6703`);
2. the local commit creates pending state;
3. the later snapshot queues behind it (`index.html:5188-5200`);
4. reconciliation sees pending and skips the remote workbook (`index.html:5001-5008`);
5. later Firebase delivery conflicts instead of merging.

The deterministic result was:

```text
events = [local-committed, remote-skipped-pending]
local A1 = present
remote B1 = absent from local active workbook
```

The checklist's §5.3 A1/B1 `both survive` criterion is therefore order-dependent and will fail for true simultaneous pending writes.

Required correction:

- Use typed per-record/per-cell operations, tombstones, and a deterministic merge/rebase, or implement a conflict resolver that can actually combine independent changes.
- Automatically capture both exact local and current remote versions before any overwrite resolution.
- Add real two-context tests where both devices commit pending state from the same base before either receives the other's snapshot.

### C-03 — Quarantine Retry bypasses poisoned-client classification

Severity: **Critical**

The new poisoned-client classifier is called only during `_bootstrapSync()` at `index.html:5053-5081`.

`retryQuarantinedSyncKey()` at `index.html:5433-5473`:

1. fetches the remote;
2. validates it;
3. reconciles it;
4. clears quarantine;
5. flushes the pending local value.

It never calls `_classifyPendingAgainstRemote()`.

Deterministic control-flow reproduction:

```json
{
  "classifierCalls": 0,
  "quarantineCleared": true,
  "deliveryAttempted": true
}
```

Unsafe scenario:

1. a key is quarantined;
2. this Mac creates or already has a revision-zero pending value while quarantined;
3. the operator repairs the cloud record to a valid legacy revision-zero document;
4. Retry validates the repaired document but does not classify the pending value;
5. quarantine clears;
6. CAS sees expected revision 0 and remote revision 0 and can accept the local replacement.

This reopens the exact destructive condition V160-003 was meant to block.

Required correction:

- Retry must classify the current pending record against the freshly fetched remote before clearing quarantine or scheduling delivery.
- Any hold must be persisted before quarantine clears.
- Tests must cover base-revision-zero pending values against repaired legacy, absent, and versioned remotes.

## High-severity findings

### H-01 — The spreadsheet authority gate can remain stuck

The persistence chokepoint itself is useful: `_stageDirtySpreadsheetSave()` refuses while `_ssAwaitingAuthority` is set. The lifecycle around it is incomplete.

#### Unconfigured transition is never reevaluated

If the user opens Spreadsheets while Firebase is in `checking`, `ssLoad()` sets the hold. If `initFirebase()` then discovers that Firebase is genuinely unconfigured, it sets `_remoteAuthority = 'unconfigured'` and returns at `index.html:4682-4695`.

That early return does not call `_reevaluateSpreadsheetAuthority()`. The only bootstrap call is at `index.html:4765-4767`, which the early return never reaches.

Reproduction:

```text
start authority = checking
open spreadsheets -> awaiting = true, writes = 0
Firebase resolves unconfigured -> awaiting remains true, writes = 0
```

The existing test sets authority to `unconfigured` before calling `ssLoad()`. It does not test the real transition from `checking` to `unconfigured`.

#### Visible Checking card does not refresh

The three stated release paths use `ssRender()`, not `ssGoHome()`/`ssRenderHomeView()`:

- real remote arrival: `index.html:4956-4964`
- reevaluation: `index.html:6532-6547`
- Start a local workbook anyway: `index.html:6553-6566`

`ssRender()` refreshes tabs/color/grid, not the home card. A user who is looking at `Checking the cloud` can remain on that stale card after:

- the real workbook arrives;
- remote absence is confirmed;
- they explicitly choose to work locally.

The hold flag may be cleared internally while the screen still appears blocked. This contradicts the checklist's live expectation that the real workbook replaces the card within seconds.

### H-02 — `STORE_SET_DEBT` is not authoritative

Claude's checklist says the static list contains every remaining unsafe synchronized `STORE.set()` call site. It does not.

The test regex at `tests/sync-persistence.test.js:1387-1392` matches only:

```js
STORE.set('literal_key', ...)
```

It cannot see variable/computed keys or calls routed through a helper.

The reported list contains 20 key families and 31 literal occurrences. Exhaustive current-source tracing found at least **22 synchronized key families and 43 per-family unsafe paths across 40 source locations**.

Missed production paths include:

- generic unsafe helper: `persistInBackground` → `STORE.set(key, value)` at `index.html:3910-3912`
- `ms_sent_emails` and `ms_sent_conv_ids`: `index.html:9620-9621`
- sent-email view timestamps: `index.html:10219`, `10237`
- staff-note pruning: `index.html:10494`
- `rc_read_convs`: `index.html:10823`
- computed synchronized `checkout_*` keys: `index.html:8545`, `8563`
- generic room-key map writer, representing four synchronized families: `index.html:9060`

The curated synchronized-key list in the test also omits:

- `rc_read_convs`
- computed `checkout_*`
- `staff`

This means the test can pass while new or existing unsafe production paths remain invisible.

Required correction:

- Make `STORE.set()` refuse synchronized keys by default at runtime, with a narrowly named reviewed replacement API for intentional whole-value replacement.
- Test the runtime invariant rather than maintaining regex debt allowances.
- If a static check remains, use AST/control-flow coverage that includes helper and computed-key paths.

### H-03 — Same-record log operations still silently lose intent

Production log add/edit/delete now use `STORE.mutate()`:

- save/edit: `index.html:10251-10296`
- delete: `index.html:10407-10421`

That is a genuine improvement for unrelated records when remote reconciliation wins the local lock first.

Same-record behavior remains unsafe:

- remote edit followed by local edit silently selects the local fields;
- remote edit followed by local delete silently deletes the edited record;
- remote delete followed by a still-open local edit silently discards the edit.

The last case is also a false-success UI defect. If the target ID is absent, the mutator does nothing at `index.html:10275-10276`, but the form is cleared and `Log entry updated!` is shown at `index.html:10286-10291`.

This was reproduced against the current production function.

The new test at `tests/sync-persistence.test.js:1395-1400` does not call `saveLogEntry()` or `deleteLog()`. It only checks counts/string presence and could be satisfied by an unrelated `STORE.mutate('logs')` call such as demo cleanup.

Required correction:

- Treat missing edit/delete targets and same-record divergence as explicit typed conflicts.
- Do not clear the form or show success unless the intended record mutation actually occurred.
- Test the production UI functions, not just the storage primitive.

### H-04 — Different-cell merge is order-dependent; structural edits remain lossy

Claude correctly acknowledges same-cell, structural, and delete-versus-edit spreadsheet conflicts as open. Two additional corrections are needed.

First, as described in C-02, the advertised different-cell fix is only valid when remote reconciliation commits before the local dirty save. It is not a true two-device merge.

Second, comments saying discarded edits remain recoverable are false:

- remote project deletion discards local project edits: `index.html:6606-6609`
- remote sheet deletion discards local sheet edits: `index.html:6624`
- local cell clear silently deletes a remotely changed cell: `index.html:6642-6645`
- local sheet/project deletion silently wins: `index.html:6648-6663`

The merged result is serialized into the pending record at `index.html:6702-6709`, and the dirty source/base are cleared at `index.html:6713-6716`. The discarded local edit is not retained in that pending record.

Spreadsheet import remains a whole precomputed `STORE.set()` replacement at `index.html:7276-7286`, as Claude reports.

### H-05 — Live failures are not durably quarantined and status can later look healthy

Bootstrap quarantine is improved in normal tested cases. Live behavior remains incomplete.

For a live snapshot decode/schema failure:

- `index.html:5201-5205` logs, sets a generic error state, and toasts;
- it does not call `_quarantineSyncKey()`;
- it does not record a per-key delivery error;
- it does not unsubscribe that key;
- it does not expose durable recovery state.

The listener error callback at `index.html:5206-5209` has the same limitation.

Later, `loadSettings()` calls:

```js
setSyncStatus(_syncReady ? 'live' : ...)
```

at `index.html:7787`. Because the rejected live key is absent from quarantine, recovery, pending, and delivery-error state, `_syncKeyStatus()` can classify it as current and the UI can return to `Synced`.

Additional UI gap:

- bootstrap records quarantine at `index.html:5109-5128`;
- neither that path nor `_quarantineSyncKey()` refreshes `_updateSyncConflictActions()`;
- the recovery panel can remain hidden until an unrelated action refreshes it.

The quarantine persistence writer at `index.html:3997-4015` also catches and swallows storage failure. It warns, which is positive, but the checklist must not describe the state as durably fail-closed in that case.

### H-06 — Recovery export does not satisfy the stated confidentiality guarantee

The v2 export defect was genuinely improved: the code now copies the complete remote document at `index.html:5390-5405`.

The checklist nevertheless says `local + remote ciphertext, never plaintext`. That is false:

- a valid legacy remote is exported verbatim and deliberately sets `containsPlaintext = true` at `index.html:5404-5405`;
- the success toast warns about this at `index.html:5421-5424`.

More seriously, the code assigns `bundle.remoteRecord` before schema classification. If `_syncDocumentKind(data)` then throws:

1. the malformed remote record remains in the bundle;
2. `containsPlaintext` remains `false`;
3. `remoteExists` remains `true`;
4. the `remoteExists === null` warning branch does not run;
5. the export can be described as encrypted even when it contains plaintext-like malformed data.

This behavior was reproduced with:

```json
{"value":{"customer":"PLAINTEXT"},"unexpected":true}
```

The file was exported and the UI used the encrypted-success path.

Cancellation is also mishandled: `{ok: true, canceled: true}` is treated as successful because `exportQuarantinedSyncKey()` checks only `result?.ok === false` at `index.html:5417-5426`.

Required correction:

- Validate/classify the complete remote record before placing it into an encrypted-labeled bundle.
- Make the file schema truthfully state whether any field may contain plaintext.
- Require an explicit high-visibility confirmation before writing legacy/plaintext recovery data.
- Treat cancellation as cancellation, not export success.
- Test v2, valid legacy plaintext, malformed record, remote read failure, and cancel.

## Medium-severity correctness issue

### M-01 — Use Cloud may not immediately migrate a legacy remote to schema v2

During poisoned-client resolution against a legacy remote:

1. `resolveSyncConflictsUseCloud()` calls `_persistRemoteValue(..., propagateToFirebase: true)` at `index.html:5649-5651`;
2. `_persistRemoteValue()` tries to schedule delivery at `index.html:4918-4919`;
3. `_scheduleSyncDrain()` refuses while the recovery hold exists at `index.html:3466-3473`;
4. the resolver clears the hold only afterward at `index.html:5655-5656`;
5. it does not schedule the new migration pending record again after clearing the hold.

The local cloud copy is restored, but the schema-v2 migration can remain pending until a later Force Sync, new write, or other scheduling event. The checklist's statement that choosing Use Cloud migrates the legacy workbook should not be considered verified.

## Findings Claude correctly leaves open

These remain valid release risks and were not addressed because `main.js`, `preload.js`, rules, and package configuration are unchanged in Claude's current source diff:

- staff cold-start Firebase authentication;
- Carrie/Step Up identity impersonation and renderer-side authorization;
- added profiles being device-local;
- legacy plaintext iCloud backup/migration;
- iCloud whole-file last-writer-wins behavior;
- release provenance/source-tag gap;
- CSP/ATS/file-protocol hardening;
- spreadsheet import and structural conflict semantics.

Claude is also correct that the main-process Firebase/identity redesign should be isolated from the data-loss repair rather than combined casually into the same release.

## Corrected operator-gate expectations

### Logs

Expected to fail today:

- concurrent A/B additions automatically both survive;
- same record edited concurrently produces a record-level merge/conflict;
- delete versus edit preserves both intents;
- Keep This Mac automatically preserves the overwritten cloud copy.

### Spreadsheets

Expected to pass only in the tested order:

- remote reconciliation first, local different-cell save second.

Expected to fail or conflict:

- both devices create pending different-cell edits from the same base;
- same-cell concurrency;
- structural versus cell change;
- delete versus edit;
- import versus remote edit.

### Startup authority

Improved:

- a fabricated default cannot pass through the normal dirty-save chokepoint while authority is unknown.

Expected to fail:

- `checking` → genuinely `unconfigured` transition releases automatically;
- visible Checking card immediately changes after real data, authoritative absence, or Work Locally.

### Poisoned recovery

Improved:

- bootstrap classifies and durably holds a revision-zero pending value against an existing legacy remote.

Expected to fail:

- quarantined-key Retry re-applies the same classification before clearing quarantine;
- Use Cloud immediately drains the legacy schema migration.

### Quarantine/status

Improved:

- ordinary bootstrap quarantine is durable when localStorage works;
- connected flush detects quarantined keys, including no-pending keys;
- current v2 remote records are included in export.

Expected to fail:

- live snapshot failures become durable per-key quarantine;
- recovery controls always appear immediately;
- every export is ciphertext-only;
- malformed plaintext-like remote is labeled truthfully.

### Updates

Expected to fail:

- offline pending state prevents installation end-to-end;
- offline quarantine without pending prevents installation;
- a renderer callback returning `false` produces a failed main-process acknowledgement.

## Test-suite corrections

Claude's report says 121/121 and later says 16 new tests. Current facts:

- `npm test`: 137 tests, 137 pass.
- Base `08e00ee`: 99 tests.
- The diff adds 40 `test(...)` declarations and removes/replaces two, for a net increase of 38.

Important coverage gaps:

- no production-function test for `saveLogEntry()`/`deleteLog()`;
- no true two-device same-base concurrent log test;
- no local-first different-cell spreadsheet test;
- no real `checking` → `unconfigured` transition test;
- release tests check updater symbols/shape but not callback `false`;
- no quarantine-Retry poisoned-pending test;
- no live invalid snapshot durable-status test;
- no malformed/plaintext/canceled recovery-export test;
- the debt test uses a literal-call regex and misses helpers/computed keys.

Passing 137/137 is therefore necessary evidence, not release-readiness evidence.

## Updater implementation

This application still does **not** use Sparkle directly.

- `main.js:20` imports `autoUpdater` from `electron-updater`.
- `main.js:137-149` explicitly handles Squirrel.Mac's update lifecycle.
- `package.json` pins `electron-updater` `6.8.9`.

The report's code changes do not replace that updater stack.

## Required next handoff to Claude

Claude should treat the following as mandatory before another verification:

1. Fix the preload boolean acknowledgement and all disconnected/quarantine update-gate states.
2. Design real two-device semantic merge/conflict behavior for logs and spreadsheets; do not equate an in-renderer lock-order fix with cross-device merge.
3. Automatically preserve both local and current cloud copies before either conflict overwrite.
4. Re-run poisoned-pending classification inside quarantine Retry.
5. Repair every spreadsheet authority transition and refresh the visible home state.
6. Replace the regex debt mechanism with a runtime prohibition/invariant for synchronized `STORE.set()`.
7. Fix same-record log edit/delete conflict and false-success behavior.
8. Make structural spreadsheet conflicts explicit and genuinely retain discarded edits.
9. Durably quarantine live per-key failures and immediately show recovery actions.
10. Make recovery export schema/labels truthful for v2, legacy plaintext, malformed records, failure, and cancellation.
11. Re-schedule the legacy Use Cloud migration after releasing the recovery hold.
12. Add the missing end-to-end and two-context tests listed above.
13. Keep the existing architectural/iCloud/provenance/hardening findings open until separately implemented and tested.
14. Do not bump, commit, tag, sign, notarize, or publish until the corrected automated suite and every staging two-device operator gate pass.

## Scope limitations

This review intentionally did not:

- connect to or mutate production Firebase;
- read or modify the real iCloud backup;
- use real owner/staff credentials;
- run a signed/notarized updater round trip;
- claim two physical Macs passed;
- commit or publish any change.

The deterministic source-level failures above are sufficient to block release without risking production data.
