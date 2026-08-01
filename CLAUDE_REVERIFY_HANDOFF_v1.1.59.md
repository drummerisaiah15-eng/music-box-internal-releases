# Music Box Internal v1.1.59 - Failed Reverification and Claude Fix Handoff

**Purpose:** Give Claude Code the exact remaining defects, reproductions, code locations, and acceptance tests after the attempted v1.1.59 repairs.

**Audit date:** July 30-31, 2026  
**Verdict:** **BLOCKED - v1.1.59 is public but is not data-safe**  
**Public release:** <https://github.com/drummerisaiah15-eng/music-box-internal-releases/releases/tag/v1.1.59>  
**Advertised release source commit:** `083fd2fbd03335818aa8e5466e018eafb1af9d02`  
**Current local HEAD:** `08e00eed70099fc3a0de3dce4e7ec5a16b0e0eea`  
**Public tag/main target:** `f4ce0a6093d00eff0738fef76a1a747dc7715150`  

## Instructions to Claude Code

Read this entire document before editing.

Do not assume the previous handoff was implemented. It was not. The v1.1.59 commits touched only MB-001, MB-008, and MB-009, and two of those attempted repairs remain unsafe.

Before editing:

1. Run `git status` and preserve all existing user changes.
2. Confirm the current commit and compare it with `083fd2f`.
3. Do not access or write production Firebase records.
4. Do not modify or delete the existing iCloud backup.
5. Do not publish, tag, notarize, upload, or install another release until the operator explicitly authorizes it.
6. Add the failing preservation assertions as permanent tests before changing the sync implementation.
7. Fix the synchronization core before making feature-level workarounds.
8. Use deterministic barriers/deferred promises for concurrency tests. Do not rely on sleeps.
9. Keep source fixes separate from release work.
10. Do not claim success from the existing `99/99` result. Those tests currently miss the confirmed data-loss behavior.

## Executive Verdict

The exact public v1.1.59 package is correctly signed, notarized, and internally consistent with the local first-party source. However, it still has two critical data-loss defects:

1. Opening Spreadsheets before Firebase initialization begins still queues an empty default workbook.
2. A queued local whole-value save can still erase unrelated remote changes in logs, spreadsheets, and every other synchronized whole-array/whole-object data set.

The new per-key quarantine behavior also introduces a false-success condition: a spreadsheet write can remain pending while the save pipeline reports success.

**Do not consider v1.1.59 ready for multi-device use.**

Operationally, until fixed:

- Do not open Spreadsheets on a fresh, newly logged-in, or unsynchronized device.
- Do not rely on the "Saved", "Save All", or "Synced" messages as proof that a quarantined data set reached Firebase.
- Avoid simultaneous edits to logs or spreadsheets from multiple devices.
- Preserve Firebase and iCloud recovery copies before any remediation.

## What Claude Actually Changed

Commits after the v1.1.58 audit source:

```text
f3c009e MB-001/008/009: Fix sync bootstrap race, nav writes, key quarantine
bb5569e MB-009: Move _syncBootstrapFailedKeys to module-level sync state block
083fd2f MB-009: Inject _syncBootstrapFailedKeys into bootstrap drain test contexts
08e00ee Bump version to 1.1.59
```

Diff from `61c61bb` to current HEAD:

```text
index.html                      74 insertions, 14 deletions
tests/sync-persistence.test.js   2 insertions
package.json                     version only
package-lock.json                version only
```

`main.js`, `preload.js`, `firestore.rules`, the workers, authentication architecture, profile storage, iCloud synchronization, and Step Up authorization were not changed.

The only test-file changes were:

```js
_syncBootstrapFailedKeys: new Set(),
```

in two existing VM contexts. No new MB-001, MB-008, or MB-009 behavior tests were added.

## What Passed

These results are real and should be preserved:

- Exact public v1.1.59 ZIP SHA-256 matched GitHub metadata:
  `2d758b4c06e19d072967269168261d80005f28ae4382c07c1fd2b7be06e246f9`
- Exact public DMG SHA-256 in provenance:
  `eda0a4349ec824b8384c34074fdb6124076103a3dd5bb143bb90c27501352b3b`
- `latest-mac.yml` SHA-256:
  `892222136d568c6105c2f175c4c1a9dd76be8abf5d492236a2267fb2812fdbe9`
- Public provenance SHA-256:
  `6969814b118241457314338e9201578df8838b547a719cfe70b9dedd5342fd77`
- Packaged first-party source hashes matched local source at `083fd2f`.
- `CFBundleShortVersionString` is `1.1.59`.
- `codesign --verify --deep --strict` passed.
- Gatekeeper accepted the app as a Notarized Developer ID build.
- The current source builds successfully as an unsigned development package.
- Existing automated suite: `99/99` passed.
- Production dependency audit: `0` vulnerabilities.
- Full dependency audit: `16 high`, `0 critical`; all are in the development/release graph.
- No hardcoded API key, private-key file, `.env`, PEM, P8, or obvious production secret was found.
- Basic encrypted local persistence works for logs and spreadsheets.
- Encrypted pending records survive a simulated restart.
- MB-008 is fixed: opening/switching spreadsheet projects and sheets no longer calls `ssSave()`.
- Existing text bounds, HTML escaping, CSV formula neutralization, Unicode handling, and import limits still pass.

Basic local restart harness result:

```json
{
  "encryptedAtRest": {
    "logs": true,
    "spreadsheets": true
  },
  "restartRoundTrip": {
    "logBody": "Unicode restart test: cafe - apostrophe O'Neil",
    "spreadsheetCell": "saved before restart"
  },
  "offlinePendingSurvives": {
    "logs": true,
    "spreadsheets": true
  }
}
```

This positive local result does **not** establish safe Firebase synchronization.

---

## V159-001 - Critical: MB-001 Spreadsheet Startup Race Is Still Present

### Status

**Attempted but not fixed.**

### Impact

If a device has no readable local spreadsheet value and the user opens Spreadsheets before `initFirebase()` marks synchronization configured, `ssLoad()` creates and saves the empty default workbook.

That durable pending record can:

- prevent the real versioned Firebase workbook from loading on that Mac;
- survive restarts;
- create a persistent conflict;
- replace a legacy revision-zero remote workbook;
- affect staff users more often because staff cold starts cannot obtain Firebase runtime credentials.

### Current Code Evidence

- `index.html:2679-2770` - `completeLogin()` waits for post-login maintenance before calling `initFirebase()`.
- `index.html:3762-3771` - `_syncConfigured` starts as `false`.
- `index.html:4203-4221` - `_syncConfigured` becomes `true` only after `initFirebase()` loads a complete credential set.
- `index.html:4287-4292` - any Firebase initialization error resets `_syncConfigured` to `false`.
- `index.html:5676-5720` - `ssLoad()` saves the default when `_syncConfigured` is false.
- `index.html:3361-3382` - the pending operation is durable.
- `index.html:4482-4502` - any different pending operation prevents the remote snapshot from being accepted.

Current unsafe condition:

```js
if (!isEncryptedByOtherProfile && (!_syncConfigured || _syncBootstrapComplete)) {
  ssSave();
}
```

`_syncConfigured === false` currently means several different things:

- Firebase configuration has not been checked yet.
- Post-login maintenance has not finished.
- Staff was denied the Owner-only runtime credential.
- Firebase authentication failed.
- Firebase is genuinely not configured.

Those states cannot safely share the same "save a default" behavior.

### Exact Reproduction

Execute the exact v1.1.59 `ssLoad()` with:

```text
STORE.get('spreadsheets') -> null
localStorage.getItem('tmb_spreadsheets') -> null
_syncConfigured = false
_syncReady = false
_syncBootstrapComplete = false
ssSave() -> increment a counter
```

Observed:

```json
{
  "beforeFirebaseInitialization": {
    "saveCalls": 1,
    "activeProject": "empty-default"
  },
  "duringConfiguredBootstrap": {
    "saveCalls": 0,
    "activeProject": "empty-default"
  },
  "afterBootstrapRemoteAbsent": {
    "saveCalls": 1,
    "activeProject": "empty-default"
  }
}
```

The first case is the release blocker.

### Required Fix

Use an explicit remote-authority lifecycle. Do not infer "remote absent" from a connection/configuration boolean.

At minimum distinguish:

- unknown/not checked
- configuration absent, authoritatively confirmed
- connecting
- authenticating
- bootstrapping
- ready, remote document exists
- ready, remote document absent
- offline/error with remote state unknown
- quarantined/recovery required

Requirements:

1. A missing local value must not call `ssSave()` while remote state is unknown.
2. A default workbook may be persisted only after bootstrap authoritatively confirms the remote spreadsheet document is absent, or after an explicit local-only user choice.
3. Authentication/network failure must not be treated as remote absence.
4. Staff credential denial must not be treated as remote absence.
5. Existing poisoned pending defaults require a backup-first recovery flow.
6. Legacy revision-zero remote data must be treated as real data.
7. Remote and local copies must both be exportable before either is replaced.

### Permanent Tests Required

- Pre-`initFirebase` open with populated versioned remote: zero default writes; remote loads.
- Pre-`initFirebase` open with populated legacy remote: zero default writes; remote is preserved.
- Firebase authentication failure: zero default cloud-bound writes.
- Network offline before bootstrap: zero default cloud-bound writes.
- Staff cold start before Owner login: zero default cloud-bound writes.
- Authoritatively absent remote after completed bootstrap: one default write.
- Already poisoned pending default + populated remote: recovery offers both and does not overwrite automatically.
- Restart with poisoned pending record: recovery remains available.

---

## V159-002 - Critical: Generic Silent Lost-Update Race Remains

### Status

**Not changed. Confirmed on the exact public v1.1.59 code.**

### Impact

A remote log or spreadsheet edit can disappear without a conflict.

This affects every synchronized key that saves a complete array/object, including:

- `logs`
- `staff_notes`
- `todo_items`
- `assigned_tasks`
- `staff`
- `custom_staff`
- `spreadsheets`
- `step_up_receipts`
- policies
- room state
- email state
- checkout data

### Root Cause

- `index.html:3572-3600` - `_queueEncryptedWrite()` clones, normalizes, and serializes a complete value **before** acquiring `_serializeKeyMutation()`.
- `index.html:3605-3610` - the stale snapshot commits after it eventually enters the per-key queue.
- `index.html:3361-3378` - a new pending record derives `baseRevision` at commit time from the latest local revision.

If remote reconciliation advances the revision while the local snapshot is waiting:

1. The local snapshot still lacks the remote edit.
2. The pending record can adopt the newer revision as its base.
3. Firebase CAS accepts the stale local snapshot.
4. The remote edit disappears without a conflict.

### Confirmed Logs Reproduction

```text
Base:       [base]
Cloud adds: [cloud-new]
Local adds: [local-new]

Required:
[base, cloud-new, local-new]
or an explicit conflict preserving both versions

Actual:
[base, local-new]
```

Failure:

```text
AssertionError: unrelated cloud log must survive
actual:   [base, local-new]
expected: [base, cloud-new, local-new]
```

### Confirmed Spreadsheet Reproduction

```text
Remote changes B1 to "remote-only".
Local typing changes A1 to "typed locally".
```

Observed:

```text
A1 = "typed locally"
B1 = undefined
```

Failure:

```text
AssertionError: unrelated remote spreadsheet cell must survive
actual: undefined
expected: "remote-only"
```

### Why the Existing Tests Pass

`tests/sync-persistence.test.js:141` checks only that the local commit occurs after the remote commit. Its values are `['cloud']` and `['local']`, and it expects only `['local']`. It therefore encodes the data-loss outcome as success.

`tests/sync-persistence.test.js:205` places remote and local edits in the same spreadsheet cell and checks only that the local visible value survives. It never asserts that an unrelated remote cell survives.

Strengthening those two existing tests produces:

```text
16 tests
14 pass
2 fail
```

### Required Fix

Fix the shared sync primitive, not individual feature functions.

Requirements:

1. Acquire the per-key mutation/reconciliation lock before reading the base value and deriving the next value; or queue mutation operations instead of precomputed snapshots.
2. Bind each local operation to the exact base revision/hash it was created from.
3. Never advance a stale operation's base revision merely because another operation completed.
4. On a revision mismatch, rebase only when merge semantics are proven.
5. Otherwise preserve local and remote ciphertext and surface an explicit conflict.
6. Acknowledgements must clear only the exact accepted operation.
7. Every array record needs a stable collision-resistant ID; `Date.now()` alone is insufficient for cross-device identity.
8. Logs and spreadsheet cells/operations need deterministic merge or conflict rules.

### Permanent Tests Required

- Convert both failing audit assertions into repository tests.
- Remote reconcile starts, local log save queues, remote commits, local commits.
- Local log save starts, remote arrives before encryption completes.
- Two devices add different logs concurrently.
- Two devices edit different logs concurrently.
- Two devices edit the same log concurrently.
- Two devices edit different spreadsheet cells concurrently.
- Two devices edit the same spreadsheet cell concurrently.
- Multiple rapid local writes while one remote reconciliation is pending.
- Restart with an operation bound to an older base revision.
- Superseded acknowledgement cannot acknowledge newer content.
- All conflicts preserve both encrypted versions and revisions.

---

## V159-003 - High: Quarantined Data Can Be Reported as Saved/Synced

### Status

**New behavior introduced by the partial MB-009 repair.**

### Impact

Per-key quarantine correctly avoids uploading a data set that failed bootstrap. However:

- `_scheduleSyncDrain()` returns `false` for a quarantined key.
- `_flushSyncDeliveries()` treats that as success.
- The pending record remains.
- `saveAllData()` and `forceSyncNow()` can display success.
- `initFirebase()` can set the global sync status to live.

A user may therefore believe the spreadsheet is in Firebase when it is only local and durably pending.

### Evidence

- `index.html:3452-3457` - quarantined key returns `Promise.resolve(false)`.
- `index.html:3483-3495` - false/skipped deliveries do not become errors.
- `index.html:4275-4285` - bootstrap returns, pending drain runs, and global status can become live.
- `index.html:4533-4579` - failed keys are quarantined, but partial failure does not reject initialization.
- `index.html:4585-4601` - Save All always shows success if flush returns without throwing.
- `index.html:4652-4664` - Force Sync does the same.

Exact probe:

```json
{
  "reportedSuccess": true,
  "pendingStillExists": true
}
```

### Additional Gaps

- There is no durable user-facing quarantine state.
- There is no recovery action that clears/retries one quarantined key.
- `_syncBootstrapFailedKeys` is in memory only.
- The source comment says quarantine lasts until recovery, but no recovery workflow exists.
- Subscriptions are still created for all keys, including quarantined keys.
- A later write to the quarantined key remains pending indefinitely during that session.

### Required Fix

1. Treat skipped/quarantined delivery as incomplete, not success.
2. `STORE.flush(..., {requireSync: true})`, Save All, Force Sync, quit/install flush, and the sync badge must fail or show partial status while any requested key remains pending/quarantined.
3. Add a persistent per-key status model:
   - current
   - locally saved/pending
   - delivering
   - conflict
   - quarantined
   - failed
4. Show which data set is not synchronized without exposing record contents.
5. Add retry/export/recovery actions.
6. Never label the global state "Synced" if any known data set is pending, conflicted, or quarantined.

### Permanent Tests Required

- Quarantined spreadsheet + pending record: Save All fails/partial, pending remains visible.
- Quarantined spreadsheet + healthy logs: logs drain, spreadsheet remains explicitly unsynced.
- Force Sync cannot report all current.
- Update installation cannot continue when required persistence is quarantined.
- Retry succeeds after compatible remote data is supplied.
- Restart reconstructs the quarantine/recovery state safely.

---

## V159-004 - High: Staff Cold-Start Firebase Sync Still Fails

### Status

**Not changed.**

### Impact

Ana, Emma, Carrie, and custom Front Desk users cannot establish Firebase synchronization after a fresh app process unless Elizabeth first authenticates Firebase in that same process.

Staff can therefore see stale local data, make offline pending edits, and trigger spreadsheet default behavior.

### Evidence

- `index.html:3893-3917` - `includePassword: true` uses `runtimeConfig`.
- `index.html:4203-4215` - staff cold start needs a password or returns Sync Off.
- `main.js:1573-1580` - `firebase-runtime-config` is Owner-only.
- `main.js:1557-1570` - staff status omits the password.

### Required Fix

Move cloud authentication/session ownership to a trusted process or short-lived role-scoped backend token flow. Do not expose the reusable Firebase password to staff renderers.

### Permanent Tests Required

- Fresh process -> each built-in/custom staff profile -> Firebase ready without Elizabeth login.
- Staff renderer cannot read or log reusable Firebase credentials.
- Offline staff edit later reconciles without silent replacement.
- Staff cold start cannot queue a default spreadsheet before remote check.

---

## V159-005 - High: Added Profiles Are Still Device-Local

### Status

**Not changed.**

### Impact

A user added on Mac A does not appear on Mac B's login screen or task dropdown.

### Evidence

- `main.js:1214` - local vault key `app_staff_profiles_v1`.
- `main.js:1233-1267` - profile list comes from that Mac's vault.
- `main.js:1429-1444` - Add User writes only to that vault.
- No synchronized profile directory was added.

### Required Fix

Create an owner-managed synchronized staff directory with immutable IDs, Front Desk default role, active/disabled state, schema version, and safe migration of existing local profiles.

### Permanent Tests Required

- Add on Mac A -> appears on Mac B and every assignment dropdown.
- New user is Front Desk only.
- Rename/disable preserves task history.
- Concurrent additions preserve both.
- Case/spacing/Unicode-equivalent duplicates are rejected.

---

## V159-006 - High: Carrie/Step Up Access Is Still Impersonable

### Status

**Not changed.**

### Impact

Renderer guards correctly hide Step Up from Ana, Emma, and custom Front Desk users. But anyone can select Carrie at login without a staff credential and receive a Carrie session.

This is profile selection, not authentication.

### Evidence

- `main.js:1418-1422` - `app-session-start-staff` accepts a profile name with no identity proof.
- `index.html:11118` - privilege is based on current name/role.
- `index.html:11304-11318` - Step Up read/write guards are renderer-side.

### Required Fix

1. Authenticate staff individually.
2. Enforce Step Up authorization in the trusted main/backend layer on every read/write/export/AI/communication path.
3. Use immutable user IDs and trusted claims, not display names.
4. Clear privilege on logout, switch, reload, and expiry.

### Permanent Tests Required

- Carrie cannot be selected without valid Carrie authentication.
- Renderer variable/name tampering cannot grant Step Up.
- Every Step Up operation rejects Ana, Emma, and custom Front Desk sessions.
- Carrie succeeds only after authentication.

---

## V159-007 - High: Legacy Plaintext iCloud Backup Still Exists

### Status

**Not changed. Confirmed still present read-only.**

Observed file:

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Music Box Internal/sync.json
```

Observed metadata:

```text
size:     1724 bytes
mode:     -rw-r--r--
modified: 2026-06-16T10:13:39-0400
format:   legacy/no format
version:  legacy/no version
entries:  absent
```

Readable operational top-level fields remain. Their values were not printed.

### Current Behavior

`index.html:10238` and the surrounding `syncToiCloud()` logic reject any existing non-v2 backup instead of migrating it.

### Required Fix

Implement a user-confirmed, bounded, backup-first migration:

1. Strictly validate legacy size and schema.
2. Create a protected recovery copy.
3. Normalize recognized fields only.
4. Encrypt a v2 envelope.
5. Write to a unique temporary target, fsync, and verify by reading back.
6. Replace/archive legacy plaintext only after verification and explicit approval.
7. Explain possible iCloud version-history retention.
8. Never print operational values.

---

## V159-008 - Medium: iCloud Backup Is Still Last-Writer-Wins

### Status

**Not changed.**

Two Macs can overwrite the same complete backup and both report success. There is no reliable generation/CAS protocol.

Prefer immutable, bounded per-device/per-time snapshots if iCloud Drive cannot provide dependable CAS.

Required test:

- Two simultaneous device backups must preserve both recovery points or give one device an explicit conflict.

---

## V159-009 - Medium: Compatibility Quarantine Is Only Partial

### Status

**Partially improved, not complete.**

Positive:

- `_bootstrapSync()` uses `Promise.allSettled()`.
- One invalid spreadsheet no longer necessarily throws the entire bootstrap.
- Healthy keys can continue.

Remaining requirements:

- Preserve/export exact invalid local and remote copies.
- Persistent per-key error state.
- User-visible recovery workflow.
- Do not report global Synced.
- Retry after migration/compatibility repair.
- Verify limits against historical production workbooks.
- Unknown future schema must be quarantined, never replaced by defaults.

Limits remain:

```text
25 sheets
10,000 populated cells
400,000 characters
600 KB serialized workbook
```

Production workbook compatibility was not inspected.

---

## V159-010 - Medium: Release Provenance Is Still Not Rebuildable

### Status

**Not fixed, and v1.1.59 is already public.**

Findings:

- Release body advertises source commit `083fd2f`.
- GitHub's public commit endpoint does not retrieve that commit.
- Public `main`, `v1.1.58`, and `v1.1.59` refs point to `f4ce0a6`, the release-repository initialization commit.
- The advertised source commit's `package.json` and `package-lock.json` say `1.1.57`, not `1.1.59`.
- Version `1.1.59` exists only in the later local commit `08e00ee`.

The packaged first-party code does match the local `083fd2f` content hashes, but an external auditor cannot rebuild the exact advertised version from public source.

Required:

1. Publish the exact reviewable source commit/archive.
2. Commit the version before building.
3. Tag the exact source state.
4. Build from a clean checkout.
5. Map source commit, tree, package version, artifact hashes, feed, notarization, and tag consistently.

---

## V159-011 - Low/Medium: Hardening Findings Remain

### Status

**Not changed.**

Exact public app still has:

- `NSAllowsArbitraryLoads=true`
- CSP `script-src 'unsafe-inline'`
- CSP `style-src 'unsafe-inline'`
- `GrantFileProtocolExtraPrivileges` enabled

Strong settings that must remain:

- context isolation
- renderer sandbox
- Node integration disabled
- web security enabled
- insecure content disabled
- packaged DevTools disabled
- RunAsNode disabled
- NODE_OPTIONS disabled
- CLI inspect disabled
- embedded ASAR integrity enabled
- only-load-from-ASAR enabled
- cookie encryption enabled

No direct XSS exploit was reproduced. Treat the remaining items as defense-in-depth, after the data-loss defects.

Deployed Firestore rules remain unverified. Test the exact deployed/staging rules with authorized and unauthorized clients.

---

## MB-008 Verification - Spreadsheet Navigation Write Amplification Is Fixed

This is the one attempted fix verified as correct.

Exact source probes:

```json
{
  "ssOpenProject": {
    "callsSpreadsheetSave": false,
    "callsRender": true
  },
  "ssSwitchProject": {
    "callsSpreadsheetSave": false,
    "callsRender": true
  },
  "ssSwitchSheet": {
    "callsSpreadsheetSave": false,
    "callsRender": true
  }
}
```

Add permanent tests so this does not regress:

- Opening a project creates zero workbook writes.
- Switching projects creates zero workbook writes.
- Switching sheets creates zero workbook writes.
- Leaving a cell edit flushes exactly the content edit, not an extra navigation write.

## Required Save and Sync Acceptance Matrix

Claude must implement and run all of this against a dedicated non-production Firebase project.

### Local Persistence

- Save log; restart immediately; exact log survives.
- Save spreadsheet cell; restart immediately; exact cell survives.
- Unicode, apostrophes, multiline text, maximum bounds, and rapid input.
- Simulated quota/write failure rolls back and reports failure.
- Offline pending records survive restart.
- Save All waits for debounce and encrypted local writes.

### Spreadsheet Retrieval

For each remote state:

- absent
- legacy revision zero
- current versioned document
- malformed
- oversized
- unknown future schema

For each local state:

- absent
- clean
- legitimate pending edit
- generated empty pending default
- locked/undecryptable
- older revision
- newer revision

Every combination needs a deterministic, documented, non-destructive result.

### Logs

- Device A and B add different logs concurrently: both survive.
- Device A edits a log while B adds another: both survive.
- Same log edited concurrently: explicit conflict or documented merge.
- Delete vs edit conflict: neither disappears silently.
- Offline log edit reconnects safely.
- Stable UUID-style record IDs across devices.
- "Saved" distinguishes local durability from Firebase acknowledgement.

### Spreadsheets

- Different cells edited concurrently: both survive.
- Same cell edited concurrently: conflict or documented merge.
- Different sheets edited concurrently: both survive.
- Structural change vs cell edit: preserve both or explicit conflict.
- Rapid typing during remote decode.
- Navigation creates no workbook write.
- Invalid/oversized remote is recoverable and does not block logs.

### Per-Key Status

- Healthy logs + quarantined spreadsheet.
- Save All reports partial/incomplete.
- Force Sync reports partial/incomplete.
- Sync badge never says Synced with pending/quarantined data.
- Retry one key without reconnecting the whole app.
- Restart reconstructs status.

### Staff and Profiles

- Fresh process staff sync for Ana, Emma, Carrie, and custom user.
- New profile propagates to a second device.
- New profile appears in task dropdowns.
- New profile remains Front Desk.
- Step Up/Owner operations denied by trusted layer.
- Authenticated Carrie workflow succeeds.

### iCloud

- v2 round trip.
- Legacy migration.
- Interrupted migration.
- Wrong PIN epoch.
- Malformed/oversized input.
- Two-device concurrent backup.
- No operational values in logs.

### Update

The app uses `electron-updater`/Squirrel.Mac, not Sparkle.

Test from a disposable previous-version install:

1. Local and Firebase test values exist.
2. Update is discovered/downloaded.
3. Pending/quarantined save prevents installation.
4. Successful flush permits installation.
5. Relaunch shows correct version.
6. Logs and spreadsheets remain intact locally and remotely.
7. Conflicts remain recoverable.

## Required Test Corrections

The current tests must be corrected before implementation:

1. In the log remote-decode race, use:

```text
remote = [base, cloud-new]
local  = [base, local-new]
```

Assert both additions survive or an explicit conflict preserves both.

2. In the spreadsheet race, put:

```text
remote edit -> B1
local edit  -> A1
```

Assert both cells survive.

3. Add an MB-001 test with `_syncConfigured=false` before `initFirebase()`. Assert zero default writes.

4. Add an MB-009 test with a quarantined pending spreadsheet. Assert flush/Save All does not report success.

5. Add MB-008 navigation no-write tests.

## Definition of Done

Do not report completion until:

- The strengthened log and spreadsheet race tests pass.
- Pre-Firebase spreadsheet opening produces zero default writes.
- Already poisoned clients have a backup-first recovery path.
- Quarantined/pending keys cannot be reported as synced.
- Staff can cold-start cloud sync securely.
- Profiles synchronize across devices.
- Carrie access requires authentication and trusted-layer authorization.
- Legacy iCloud plaintext has a verified migration flow.
- Two-device staging tests pass for logs and spreadsheets.
- Previous-version update/install/relaunch preserves data.
- Public source provenance maps to the exact build.
- The operator reviews the evidence and authorizes release.

## Audit Limitations

- No production Firebase writes were made because the confirmed races can lose data.
- No real production two-device test was attempted.
- Production spreadsheet contents were not inspected.
- Deployed Firestore rules were not independently retrieved.
- Automated Mac UI control could not safely distinguish among multiple installed copies sharing the same bundle identifier, so no destructive/live UI save was attempted.
- The signed package was verified read-only; final live update/relaunch was not performed.
- No app source fix, release mutation, or production-data mutation was made during this reverification.

## Claude's Final Response Must Include

1. Root cause and synchronization model.
2. Exact files/functions changed.
3. Permanent regression tests added.
4. Full test output.
5. Local restart evidence.
6. Two-device staging evidence for logs and spreadsheets.
7. Conflict/recovery screenshots or structured evidence.
8. Staff cold-start and cross-device profile evidence.
9. iCloud migration evidence using fixtures only.
10. Update install/relaunch evidence.
11. Remaining risks.
12. Commit hashes.
13. Explicit confirmation that no new release was published without operator approval.
