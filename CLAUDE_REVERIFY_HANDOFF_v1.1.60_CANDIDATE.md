# Music Box Internal — Independent Reverification of the Unreleased v1.1.60 Candidate

**Audit date:** 2026-07-30  
**Verdict:** **NO-GO — DO NOT RELEASE**  
**Audit mode:** Read-only source, test, package, dependency, and public-provenance verification  
**Audited source:** Uncommitted working tree on `main` above `08e00eed70099fc3a0de3dce4e7ec5a16b0e0eea`  
**Package version:** `1.1.59`  

This document supersedes the “fixed” conclusions in
`OPERATOR_RELEASE_CHECKLIST_v1.1.60.md`. Some of Claude’s changes are real
improvements, but the candidate still contains independently reproduced silent
data-loss paths. Do not bump, commit, tag, sign, notarize, publish, or install
this candidate on production devices.

No production Firebase document was read or written. The real iCloud backup was
not opened or modified. No source fix was made during this audit.

---

## 1. Executive summary

Claude added useful primitives and tests, but did not connect the primary
collision-safe primitive to the real features.

The most important result is:

> `STORE.mutate()` exists and passes a direct unit test, but production has zero
> `STORE.mutate()` call sites. The real log, note, to-do, task, receipt, room,
> policy, email-state, staff, and communication flows still save precomputed
> whole-value snapshots through the unsafe `STORE.set()` path.

An exact deterministic current-source reproduction produced:

```json
{
  "expected": ["base", "cloud-new", "local-new"],
  "actual": ["base", "local-new"],
  "pendingBaseRevision": 6,
  "pendingCiphertext": "E:[\"base\",\"local-new\"]"
}
```

The cloud addition disappeared, yet the stale pending value adopted cloud
revision 6 as its base. Firebase CAS can therefore accept the stale value with
no conflict. This is the original critical silent-lost-update defect.

The spreadsheet work fixes one narrow case: if a remote reconcile is already
running in the same renderer and changes B1 while the user changes A1, both
cells can survive. It does not safely handle:

- a user editing the temporary default workbook before cloud authority is
  established;
- a client already poisoned by the v1.1.59 default-workbook bug;
- same-cell edits;
- insert/delete/rename and cell-edit collisions;
- project/sheet deletion versus an edit;
- imports;
- genuinely simultaneous edits originating on two devices.

Quarantine/status work is also incomplete. Retry can clear quarantine without
decoding the remote copy, current v2 recovery export omits the remote envelope,
runtime compatibility errors are not durably quarantined, and some
quarantined/offline states still pass Force Sync or update-install flush gates.

---

## 2. Source and evidence binding

### Repository state

```text
branch: main
HEAD:   08e00eed70099fc3a0de3dce4e7ec5a16b0e0eea
version in package.json/package-lock.json: 1.1.59
```

Tracked implementation changes:

```text
index.html                      614 insertions, 25 deletions
tests/sync-persistence.test.js  345 insertions, 11 deletions
```

No implementation change exists in:

```text
main.js
preload.js
firestore.rules
pdf-worker.js
spreadsheet-worker.js
package.json
package-lock.json
release.sh
```

Untracked repository files:

```text
.fuse_hidden0000000800000001
.fuse_hidden0000000900000002
CLAUDE_REVERIFY_HANDOFF_v1.1.59.md
OPERATOR_RELEASE_CHECKLIST_v1.1.60.md
```

The two `.fuse_hidden...` files are different 634 KB HTML snapshots. They were
preserved untouched. Their presence, plus the other untracked files, means the
current release script’s clean-worktree gate will stop.

### Attached checklists

Both user-supplied `OPERATOR_RELEASE_CHECKLIST_v1.1.60.md` attachments are
byte-for-byte identical:

```text
SHA-256:
7e568b82a72a5e3fe28850fd5040af8628548f0132e8539f1adb7e318084b0ab
```

The repository copy matches them.

### Test count discrepancy

The checklist says 111/111 and “12 new tests.” The actual candidate has:

```text
HEAD baseline:             99 tests
Current candidate:        117 tests
Baseline sync tests:       16
Current sync tests:        34
Net added sync tests:      18
```

All 117 pass, but several tests exercise new helpers directly instead of the
production feature call sites.

---

## 3. Finding status matrix

| ID | Severity | Reverification result |
|---|---:|---|
| V160-001 | **Critical** | Production whole-record saves still silently lose remote edits |
| V160-002 | **Critical** | Spreadsheet remains editable before remote authority; startup loss/conflict path remains |
| V160-003 | **Critical** | Already-poisoned v1.1.59 pending default can overwrite a legacy revision-zero workbook |
| V160-004 | **Critical** | Spreadsheet same-cell and structural concurrency silently discards one side |
| V160-005 | **High** | Spreadsheet import bypasses the merge and uses unsafe whole-value replacement |
| V160-006 | **High** | Quarantine Retry/bootstrap can clear quarantine without validating remote data |
| V160-007 | **High** | Recovery export omits the current v2 remote envelope |
| V160-008 | **High** | Save/Force Sync/update gates still report success in some unsynced states |
| V160-009 | **High** | Live compatibility failures are not durably quarantined; recovery controls may stay hidden |
| V159-004 | **High** | Staff cold-start Firebase sync remains broken |
| V159-006 | **High** | Carrie/Step Up access remains impersonable and renderer-enforced |
| V159-005 | **High** | Added profiles still exist only on one Mac |
| V159-007 | **High** | Legacy plaintext iCloud migration remains unimplemented |
| V159-008 | **Medium** | iCloud backup remains cross-device last-writer-wins |
| V159-010 | **High** | Release provenance pipeline still cannot publish rebuildable source |
| V159-011 | **Medium** | CSP, ATS, and file-protocol hardening remain open |
| MB-008 | Pass | Spreadsheet project/sheet navigation produces zero workbook writes |

---

## 4. V160-001 — Critical: real feature saves still use the unsafe primitive

### What Claude added

Claude added:

- `_readSyncMutationBase()` — `index.html:3615`
- `_queueEncryptedMutation()` — `index.html:3626`
- `STORE.mutate()` — `index.html:3814`

The direct unit test at `tests/sync-persistence.test.js:141-218` calls
`_queueEncryptedMutation()` and passes.

### What production actually calls

Production contains:

```text
47 STORE.set(...) call sites
0  STORE.mutate(...) call sites
```

The unsafe chain remains:

1. `_queueEncryptedWrite()` snapshots and serializes the complete value before
   entering the key lock — `index.html:3697-3720`.
2. It commits that precomputed snapshot only after it acquires the lock —
   `index.html:3730-3735`.
3. `STORE.set()` calls this old path — `index.html:3782-3813`.
4. `_writePendingSyncRecord()` obtains `baseRevision` at commit time —
   `index.html:3362-3379`.

If a remote reconcile commits while the stale local write waits, the local
value did not include the remote edit, but its pending record adopts the newer
remote revision anyway.

### Real log path

`saveLogEntry()`:

- snapshots logs before the lock — `index.html:9863`;
- changes that stale array — `index.html:9864-9872`;
- calls `STORE.set('logs', logs)` — `index.html:9874`.

`deleteLog()` does the same at `index.html:9998-10001`.

### Independent reproduction

The audit harness ran the exact current functions:

```text
/private/tmp/music-box-v1160-independent-audit.js
```

Output:

```json
{
  "productionStoreSetRace": {
    "expected": [
      "base",
      "cloud-new",
      "local-new"
    ],
    "actual": [
      "base",
      "local-new"
    ],
    "pendingBaseRevision": 6,
    "pendingCiphertext": "E:[\"base\",\"local-new\"]"
  }
}
```

This is a deterministic silent data-loss reproduction, not a theoretical
warning.

### Affected synchronized data

Current whole-value production paths include:

- logs;
- staff notes;
- to-do items;
- assigned tasks;
- Step Up receipts;
- policies;
- room overrides/exclusions/instructor/time rules;
- checkout state;
- flagged/deleted/sent email state;
- Microsoft sent state;
- custom staff and staff-directory overrides/removals;
- communication analyzed/handled IDs;
- spreadsheet import.

### Stable IDs are also incomplete

Logs, notes, to-dos, and tasks commonly use `Date.now()` as the record ID.
Different devices can generate the same ID within one millisecond. IDs must be
created once, outside any retried mutator, using a stable random/device-qualified
identifier.

### Required repair

1. Prohibit `STORE.set()` for synchronized keys unless the call is an explicit,
   reviewed whole-document replacement with conflict preservation.
2. Convert each user intent to an in-lock semantic operation:
   append-by-ID, update-by-ID, delete-by-ID, set-membership change, or keyed map
   update.
3. Generate IDs/timestamps once outside the mutator so preview/retry does not
   create different records.
4. Add tests through the actual feature functions, not just private helpers.
5. Add a lint/static test that fails if a synchronized key is passed to
   `STORE.set()` outside a small allowlist.

---

## 5. V160-002 — Critical: the startup workbook is protected only until a user edits it

`ssLoad()` now avoids immediately saving the default workbook while
`_remoteAuthority` is unknown/checking/connecting/authenticating/bootstrapping,
which is a real improvement.

However, it still constructs and displays an editable default workbook at
`index.html:6180-6203`.

Any typing, paste, formatting, import-like operation, or structural change calls
`ssSave()`/`_scheduleSpreadsheetSave()` without checking remote authority:

```text
ssSave():                       index.html:6401-6403
_scheduleSpreadsheetSave():    index.html:6405-6407
```

At the first edit, `_beginSpreadsheetSaveStage()` reserves the spreadsheet key
lock immediately and then waits up to 500 ms inside it. A bootstrap reconcile
that arrives afterward queues behind that dirty-default save.

Result:

1. the temporary default becomes durable;
2. a pending record is created at revision zero;
3. the real remote workbook is rejected by the early pending branch;
4. a v2 workbook enters conflict, or a legacy revision-zero workbook can be
   overwritten.

If remote reconciliation wins the lock first, `_mergeSpreadsheetEdits()` may
still discard the pre-bootstrap edit when the temporary project/sheet IDs do
not exist in the remote workbook.

### Required repair

Spreadsheets must show an explicit loading/read-only state while authority for
the `spreadsheets` key is unknown. Do not expose an editable default until:

- the remote workbook was accepted; or
- remote absence was authoritatively established; or
- the user explicitly chooses a local-only/recovery action after seeing the
  consequences.

Add an integration test that opens Spreadsheets, types before bootstrap, and
then delivers a populated remote workbook in both lock orders.

---

## 6. V160-003 — Critical: poisoned v1.1.59 clients are not recovered

The checklist itself requires a poisoned-client recovery test, but no recovery
path was implemented.

`_reconcileRemoteSnapshot()` returns immediately for any pending local record:

```text
index.html:4814-4821
```

It does not decode or inspect the real remote workbook.

For a v1.1.59 client with:

- a pending empty default;
- pending base revision `0`;
- a real legacy remote document whose effective revision is also `0`;

`syncPush()` sees the expected revision and treats the local pending default as
the permitted legacy upgrade. The real workbook can be replaced by the empty
one as schema-v2 revision 1.

The existing test “CAS upgrades an exact legacy remote document” at
`tests/sync-persistence.test.js:638-690` confirms that any revision-zero local
pending value is allowed to replace the legacy document. There is no test that
distinguishes a legitimate migration from a poisoned default.

### Required repair

Before any pending default created by an affected version can drain:

1. retrieve and export the exact remote record;
2. detect the default-workbook signature and affected client/version state;
3. block automatic delivery;
4. show explicit “Use Cloud / Keep This Mac / Export Both” recovery;
5. preserve both exact encrypted/raw records and revisions before resolving.

Do not rely on ordinary CAS to recover revision-zero legacy data.

---

## 7. V160-004 — Critical: spreadsheet merge is not a conflict-safe three-way merge

The function is named and described as a three-way merge, but it contains no
conflict detection.

### Same cell

Starting value: `original`  
Remote value: `remote-edit`  
Local value: `local-edit`

Current output:

```json
{
  "merged": "local-edit",
  "conflictSurfaced": false
}
```

The remote value is silently discarded.

### Local sheet deletion versus remote cell edit

If the remote edits a cell on `s1` while the local device deletes `s1`,
`index.html:6280-6284` removes the complete remotely edited sheet.

Independent output:

```json
{
  "remoteCellSurvived": false,
  "remainingSheetIds": ["s2"]
}
```

### Remote sheet deletion versus local cell edit

At `index.html:6255-6256`, the merge skips a locally edited sheet that the
remote deleted.

Independent output:

```json
{
  "localCellSurvived": false,
  "remainingSheetIds": ["s2"]
}
```

The comment says the local copy remains recoverable in an encrypted pending
record. That is incorrect:

- only the merged result is committed/pended at `index.html:6334-6341`;
- `_ssDirtyWorkbook` and `_ssDirtyBase` are then cleared at
  `index.html:6345-6348`;
- the discarded dirty sheet/project is not in the pending ciphertext.

Project deletion, rename collisions, row/column structural operations, and
coordinate shifts have the same class of problem.

### True two-device concurrency

The passing different-cell test is a same-renderer ordering test: a remote
reconcile already holds the local key lock, then a local edit queues behind it.

Two devices that start from the same revision and edit different cells still
race at Firebase CAS:

- one write wins;
- the other conflicts;
- no automatic operation merge runs against the newly committed remote value.

Both cells are not automatically visible in one current workbook, which means
the checklist’s “A edits A1, B edits B1 — both survive” live gate is not met.

### Required repair

Use an operation journal or a real three-way merge with explicit conflict
objects:

- cell changes keyed by project/sheet/coordinate;
- structural operations with stable IDs and coordinate transforms;
- delete/edit and rename/rename conflict types;
- preserved exact local and remote versions;
- no silent winner for a path changed on both sides.

---

## 8. V160-005 — High: spreadsheet import bypasses the new save path

Spreadsheet import normalizes an entire workbook and calls:

```text
STORE.set('spreadsheets', normalized)
index.html:6879-6889
```

It bypasses `_ssDirtyBase`, `_mergeSpreadsheetEdits()`, and the spreadsheet
staged-save path.

An import queued during remote reconciliation can therefore replace a newer
remote workbook using the unsafe revision-binding behavior described in
V160-001.

Import must either:

- be an explicit whole-workbook replacement that always produces a conflict
  and preserves both versions; or
- be converted into reviewed semantic operations.

---

## 9. V160-006 — High: quarantine can clear without remote validation

When a local pending record exists, `_reconcileRemoteSnapshot()` returns before
`_decodeSyncValue()`:

```text
index.html:4814-4821
```

Both callers interpret this nonthrowing return as a clean recovery:

- bootstrap unconditionally clears quarantine —
  `index.html:4872-4875`;
- Retry clears quarantine and reports synchronized —
  `index.html:5173-5199`.

Independent Retry result:

```json
{
  "result": true,
  "decodeCalls": 0,
  "flushCalls": 1,
  "stillQuarantined": false
}
```

The incompatible remote value was never decrypted, parsed, or normalized.

### Required repair

Quarantine may clear only after a dedicated validation routine proves the
current remote record is readable and schema-valid. A pending local value must
not bypass that validation. Return a typed reconciliation result and require an
explicit `validatedRemote: true` condition before clearing.

---

## 10. V160-007 — High: “Export copies” omits current remote data

Current schema-v2 Firestore values are envelope objects:

```text
index.html:4391-4396
```

The quarantine export stores remote data only when `data.value` is a string:

```text
index.html:5141-5147
```

Therefore, a normal current remote envelope exports as:

```json
{
  "remoteCiphertext": null,
  "remoteRevision": 8
}
```

The UI then says the encrypted recovery copy was exported successfully.

Legacy plaintext arrays/objects are also omitted.

### Required repair

Export the complete validated remote record/envelope, not a guessed string
field. Include:

- complete remote value;
- schema version;
- revision;
- op ID;
- writer;
- relevant timestamps;
- local ciphertext and pending metadata;
- a format version and integrity hash.

For legacy plaintext, clearly warn that the recovery file contains plaintext
and require an encrypted destination/container.

---

## 11. V160-008 — High: sync and update truthfulness still fail open

### Quarantined key without a pending record

`_flushSyncDeliveries()` builds its targets only from keys with pending records:

```text
index.html:3509-3512
```

It only reports quarantined keys inside that target list:

```text
index.html:3522-3533
```

Independent result:

```json
{
  "flushReportedSuccess": true,
  "quarantined": true,
  "pending": false
}
```

### Force Sync ignores quarantined data absent from local cache

`forceSyncNow()` filters its verification keys to those already in `_decCache`
at `index.html:5006`.

On a fresh device with an invalid remote spreadsheet and no local spreadsheet
cache, the quarantined key is excluded from the final unsynced check.

Independent current-function output:

```json
{
  "result": true,
  "notice": "Firebase acknowledged 0 pending write(s); 0 data set(s) are current."
}
```

### Update installation while offline or quarantined

The lifecycle flush used by quit/update:

```text
index.html:13338-13345
```

passes:

```js
{
  includeSync: _syncReady && _syncBootstrapComplete,
  requireSync: false
}
```

Consequences:

- if Firebase is offline, pending data is not required to reach the cloud;
- a quarantined key with no pending record passes connected flush;
- main receives `true` and permits `quitAndInstall()`.

This fails the checklist requirement that pending/quarantined saves prevent
update installation.

### Badge failure mode

`setSyncStatus('live')` catches any exception from `_unsyncedSyncKeys()` and
substitutes an empty list at `index.html:4462-4465`.

A corrupt pending record can make `_readPendingSyncRecord()` throw; the catch
can then display `☁ Synced`. Status must fail closed to “unknown/error.”

### Required repair

Define one authoritative flush contract used by Save All, Force Sync, normal
quit, and update install. It must fail if any known key is:

- pending;
- delivering;
- conflicted;
- quarantined;
- failed;
- corrupt;
- not bootstrapped/unknown.

Only a separately labeled “Quit with local-only pending data” flow should allow
ordinary quit, and update installation should remain blocked until the user
explicitly resolves the condition.

---

## 12. V160-009 — High: compatibility quarantine is not complete

### Live failures are not durable

Errors from `onSnapshot()` reconciliation at `index.html:4978-4982` only:

- log a warning;
- set generic Sync Error;
- show a toast.

They do not:

- call `_quarantineSyncKey()`;
- stop the key’s subscription;
- persist across restart;
- expose Export/Retry.

### Recovery controls may remain hidden

Bootstrap records quarantine at `index.html:4886-4905`, but neither
`_quarantineSyncKey()` nor `_bootstrapSync()` calls
`_updateSyncConflictActions()`.

The recovery panel may therefore remain hidden until an unrelated drain,
conflict, restore, or disconnect refreshes it.

### Quarantine persistence is not fail-closed

`_saveSyncQuarantineState()` catches and logs localStorage failures at
`index.html:3963-3972`. The caller continues as though durable quarantine
exists. If persistence fails, restart safety is not guaranteed.

### Required repair

- Use one quarantine transition for bootstrap and live errors.
- Persist successfully before reporting the key quarantined.
- Stop only that key’s subscription/delivery.
- Refresh recovery UI immediately.
- Keep the global status non-green.
- Test localStorage quota/corruption failures.

---

## 13. Architectural findings Claude explicitly left open

These remain confirmed because `main.js`, `preload.js`, and `firestore.rules`
did not change.

### V159-004 — High: staff cold-start sync

- Staff can obtain public Firebase config/status but not the password:
  `main.js:1557-1580`.
- `initFirebase()` still needs the reusable password in the renderer:
  `index.html:4500-4524`.
- Staff cold start therefore enters `credential-denied`.

The new authority state prevents an immediate empty-default save. It does not
retrieve the real workbook or synchronize staff edits.

Staff can work against stale local data and accumulate pending edits until an
owner reconnects Firebase in that process.

### V159-006 — High: Carrie/Step Up impersonation

`app-session-start-staff` accepts only a display name:

```text
main.js:1418-1422
```

Anyone at the Mac can select Carrie and receive the
`Operations & Events` role without a Carrie-specific credential.

Step Up access is checked in renderer functions such as:

```text
index.html:5784-5787
index.html:11893-11909
```

`step_up_receipts` remains an ordinary shared Firebase key, and
`firestore.rules` uses the same studio member identity for every key.

Renderer UI hiding is not an authorization boundary.

### V159-005 — High: added profiles are device-local

Custom profiles are stored in the local safeStorage vault:

```text
main.js:1214
main.js:1233-1267
main.js:1429-1444
```

Positive same-device behavior is verified:

- added users are forced to `Front Desk`;
- they do not inherit Carrie/Owner UI access;
- they appear in applicable task dropdowns on that Mac.

Cross-device behavior is not implemented:

- Mac B does not receive the profile;
- Mac B cannot log in as that user;
- task records may sync by display name without a corresponding profile.

### Required architectural direction

Move Firebase session ownership and Firestore operations into a trusted
main/backend layer, add authenticated immutable staff IDs, enforce per-key roles
there and in Firestore rules, and synchronize the owner-managed profile
directory.

---

## 14. iCloud findings remain open

### V159-007 — legacy plaintext

Legacy non-v2 backups are rejected, not safely migrated. No fixture-backed
migration was added. Do not run migration experiments against the real iCloud
file.

### V159-008 — cross-device last-writer-wins

The main process serializes and atomically renames writes inside one process,
which is good local durability.

There is still no cross-device generation, ETag, CAS, or recheck before replacing
the one shared `sync.json`. Two Macs can both report success while the later
write replaces the earlier backup.

Use immutable bounded per-device snapshots, or an actual coordinated store with
CAS. iCloud `sync.json` must remain described as manual backup, not live
multi-device sync.

---

## 15. Release/updater/provenance

### This candidate was not released

The source and lockfile still say `1.1.59`; no v1.1.60 tag or release was
created.

An unsigned test package built successfully into `/private/tmp`. Its packaged
`index.html` SHA-256 exactly matched the audited working-tree `index.html`:

```text
6c60b4bc825595a53cf28cf62a26fb9965fa5d1cdcc52f7b28fcc4b64793ec7f
```

Its bundle version remains `1.1.59`.

### The updater is not Sparkle

The application uses:

```text
electron-updater 6.8.9
Squirrel.Mac installation behavior
```

There is no Sparkle framework/integration. Any release test should therefore
test the `electron-updater` feed, ZIP/blockmap, Squirrel.Mac restart, and the
renderer flush gate.

### V159-010 — provenance remains unrebuildable

Public read-only verification found:

```text
public main:   f4ce0a6093d00eff0738fef76a1a747dc7715150
public v1.1.59 tag:
               f4ce0a6093d00eff0738fef76a1a747dc7715150
release body advertises:
               083fd2fbd03335818aa8e5466e018eafb1af9d02
public commit API for advertised commit:
               HTTP 422
public commit API for current local HEAD:
               HTTP 422
```

All visible public historical tags also point to the same public default-branch
commit instead of their advertised source commits.

The release tooling explains the mismatch:

1. `release.sh` records `SOURCE_COMMIT` before the version bump —
   `release.sh:160-161`.
2. It then runs `npm version --no-git-tag-version` —
   `release.sh:261-264`.
3. It builds a detached worktree at the old commit with uncommitted
   `package.json`/`package-lock.json` copied over —
   `release.sh:283-287`.
4. It never commits or pushes that exact versioned source.
5. The publisher creates a release without `target_commitish` —
   `tests/publish-verified-release.js:805-819`.
6. GitHub creates the release tag at public default branch, while the body
   advertises the unpublished local commit.

The checklist instruction “commit version bump before building” cannot be
implemented by the current script as written. The script insists the requested
next version is greater than the already committed package version and then
performs its own uncommitted bump.

Fix and test the release pipeline before any v1.1.60 publication.

---

## 16. Security and dependency results

### Production dependency graph

Online audit:

```text
npm audit --omit=dev
0 vulnerabilities
```

### Full build/development graph

Online audit:

```text
npm audit
16 high, 0 critical
```

The findings are in build/development tooling, principally the
`electron-builder` / `@electron/asar` dependency graph through glob, minimatch,
brace-expansion, ejs, and related packages.

This is not evidence of 16 directly reachable vulnerabilities in the shipped
runtime. It is still a release supply-chain/CI availability concern and must be
reviewed deliberately. Do not run an automatic major/downgrade “audit fix”
without validating the release gates.

### Hardening remains open

Positive:

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer sandbox enabled
- navigation/window creation restricted
- narrow preload APIs
- release fuses disable RunAsNode and NODE_OPTIONS
- embedded ASAR integrity and ASAR-only loading enabled

Open:

- renderer CSP still permits `script-src 'unsafe-inline'`;
- many inline event handlers remain;
- packaged ATS still contains `NSAllowsArbitraryLoads = true`;
- `GrantFileProtocolExtraPrivileges` fuse remains enabled;
- Firebase is still directly renderer-hosted with a reusable shared credential.

These are defense-in-depth gaps, not the primary release blocker. The
reproduced data-loss defects are already sufficient to stop release.

---

## 17. Local persistence, input, navigation, and latency results

### Verified passing

Independent encrypted restart round trip:

```json
{
  "encryptedAtRest": {
    "logs": true,
    "spreadsheets": true
  },
  "restartRoundTrip": {
    "logBody": "Unicode restart test: cafe ☕ - apostrophe O'Neil",
    "spreadsheetCell": "saved before restart"
  },
  "offlinePendingSurvives": {
    "logs": true,
    "spreadsheets": true
  }
}
```

Navigation:

```json
{
  "ssOpenProject": { "callsSpreadsheetSave": false },
  "ssSwitchProject": { "callsSpreadsheetSave": false },
  "ssSwitchSheet": { "callsSpreadsheetSave": false }
}
```

Input protections in the passing regression suite include:

- native edit shortcuts rather than a global UTF-16 deletion shim;
- bounded dynamic/native input fields;
- surrogate-safe truncation;
- HTML/attribute escaping;
- bounded spreadsheet typing/paste/import;
- debounced archive search.

### CPU latency microbenchmark

Twenty current-function merges of a 10,000-cell workbook:

```json
{
  "medianMs": 13.14,
  "p95Ms": 19.48,
  "maxMs": 19.48
}
```

No deterministic CPU regression was observed in this isolated merge benchmark.
It does not prove end-to-end UI, encryption, Firebase, or two-device latency.

### GUI limitation

The machine has multiple installed copies with the same bundle identifier, and
an existing Music Box process held the single-instance identity. The audit did
not quit or manipulate the user’s running app. A safe production-like GUI test
requires a uniquely identified staging build and isolated iCloud/Firebase
configuration.

---

## 18. Automated test assessment

Command:

```text
npm run vendor:prepare && npm test
```

Result:

```text
117 passed
0 failed
```

Why this does not produce a release-ready verdict:

- the log race test invokes `_queueEncryptedMutation()` directly;
- no production feature calls `STORE.mutate()`;
- different-cell spreadsheet test covers one same-renderer lock order;
- no test types into the temporary workbook before bootstrap;
- no poisoned legacy revision-zero client test;
- no same-cell or structural conflict test;
- no import/reconcile test;
- no Retry-with-pending validation test;
- no current-v2 export test;
- no live snapshot quarantine test;
- no quarantine-without-pending flush test;
- no offline updater-gate test;
- no failed quarantine-persistence test;
- no real two-device staging test.

Passing tests are necessary, but the missing production-path assertions make
the suite materially overstate the fix.

---

## 19. Required fix order for Claude

Do not make scattered call-site substitutions without a data model.

### Phase 1 — stop active loss

1. Make spreadsheets read-only until per-key remote authority is known.
2. Add poisoned-client detection/recovery before any legacy revision-zero
   pending default can drain.
3. Prohibit unsafe `STORE.set()` for synchronized keys.
4. Convert logs, notes, to-dos, tasks, receipts, policies, directory state,
   room state, checkout, and communication state to semantic mutations.
5. Give records stable random IDs generated once outside mutators.

### Phase 2 — spreadsheet conflict semantics

6. Replace the current structural merge with an operation journal or typed
   conflict-aware merge.
7. Preserve exact local/remote versions for every conflict.
8. Route import through an explicit conflict-preserving replacement flow.

### Phase 3 — quarantine and truthfulness

9. Validate remote data before clearing quarantine, even with pending local
   data.
10. Export the complete v2 envelope and safely handle legacy plaintext.
11. Quarantine live compatibility errors and show recovery immediately.
12. Make Save All, Force Sync, quit, updater install, and the badge use one
    fail-closed status model.

### Phase 4 — architecture

13. Move Firebase session/data access to trusted main/backend code.
14. Add authenticated immutable staff identities.
15. Enforce Step Up access in trusted code and Firestore rules.
16. Synchronize the owner-managed staff profile directory.
17. Implement fixture-tested legacy iCloud migration and non-overwriting
    per-device backup snapshots.

### Phase 5 — release pipeline

18. Make the exact versioned source a public commit before building.
19. Push the exact tag before creating the GitHub release.
20. Set and verify `target_commitish`.
21. Prove public retrieval of commit, tree, tag, provenance, feed, and artifacts
    before publication.

---

## 20. Tests required before the next recheck

### Production-path integration tests

- Actual `saveLogEntry()` during remote reconciliation preserves both additions.
- Actual log edit while remote adds another record.
- Actual delete/edit collision preserves both versions or surfaces conflict.
- Staff note, to-do, task, receipt, policy, room, checkout, directory, and
  communication feature functions get equivalent coverage.
- Static assertion: no unsanctioned synchronized `STORE.set()` calls.

### Spreadsheet

- Type before bootstrap in both key-lock orders.
- Poisoned v1.1.59 default pending versus real v2 remote.
- Poisoned v1.1.59 default pending versus real legacy revision-zero remote.
- Different cells from two independent clients.
- Same cell.
- Row insert/delete versus cell edit.
- Sheet/project delete versus edit.
- Rename versus rename/edit.
- Import versus remote edit.
- Every conflict exports and preserves exact local and remote versions.

### Quarantine/status/update

- Persisted quarantine + pending value does not clear before remote decode.
- Current v2 remote envelope appears completely in export.
- Legacy plaintext recovery is explicit and encrypted.
- Live invalid snapshot enters durable quarantine and unsubscribes only that key.
- Recovery UI appears immediately.
- Quarantine persistence failure is fail-closed.
- Quarantined key without pending blocks full-sync and updater gates.
- Offline pending data blocks update installation.
- Corrupt pending metadata cannot render “Synced.”

### Profiles/auth/iCloud

- Fresh-process Ana, Emma, Carrie, and custom-user sync.
- Carrie authentication cannot be impersonated.
- Step Up rejected in trusted process and Firestore rule.
- New profile appears on Mac B with immutable ID and Front Desk authority.
- Two concurrent iCloud backups preserve two recovery points.

### Real staging

Use two Macs and a disposable Firebase project with deployed candidate rules.
Never use production data for destructive/concurrency tests.

---

## 21. Final release gate

This candidate is not releasable.

Do not ask the operator to validate a DMG yet. The deterministic current-source
reproductions already prove that save/sync correctness is not met.

The next handoff should include:

1. a clean committed candidate;
2. exact source commit and public branch/tag plan;
3. production-path test evidence;
4. poisoned-client recovery evidence;
5. quarantine/export/update-gate evidence;
6. two-device staging logs for logs and spreadsheets;
7. no open critical/high data-integrity findings.

