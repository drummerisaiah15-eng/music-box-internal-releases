# Music Box Internal — Operator Verification Checklist (pre-v1.1.60)

**Status: NOT RELEASABLE. Do not tag, sign, notarize, or publish until every gate below passes.**

Source state: working tree on top of `08e00ee`. Nothing has been committed, tagged, or published.
No production Firebase record was read or written. The existing iCloud backup was not touched.

Automated suite: **121/121 passing on macOS** (99 at baseline).

---

## 0. CORRECTION — this document previously overstated the fix

An independent reverification (`CLAUDE_REVERIFY_HANDOFF_v1.1.60_CANDIDATE.md`) found that an
earlier revision of this checklist marked V159-002 "Fixed" when it was not. The correct primitive
(`STORE.mutate()`) had been added and unit-tested, but **zero production call sites used it** — every
real feature still saved a precomputed whole-value snapshot through the unsafe `STORE.set()` path.
The audit reproduced deterministic data loss against the then-current source. That finding was
correct, and the status table below has been rewritten to reflect verified reality.

Two other claims in that revision were also wrong:
- The "Export copies" recovery button captured **nothing** for healthy remotes. It looked for a
  string `data.value`, but schema-v2 documents are envelopes keyed on `ciphertext`.
- Test count was stated as 111/12-new; the real numbers were 117/18-new.

Treat any status below as provisional until the §5 live gates pass.

---

## 1. Verified fixed (automated tests only — not yet live-verified)

| ID | Defect | Status |
|----|--------|--------|
| V159-001 | Spreadsheet startup race writes a default over real cloud data | Fixed |
| V159-003 / V160-008 | Quarantined or corrupt data reported as synced | Fixed, fail-closed |
| V159-009 | Compatibility quarantine only partial | Fixed (durable) |
| V160-006 | Quarantine cleared without validating the remote copy | Fixed |
| V160-007 | Recovery export omitted the v2 remote envelope | Fixed |
| V160-003 | Poisoned v1.1.59 client can overwrite a legacy workbook | Fixed (held for explicit resolution) |
| V160-002 | Default workbook editable before remote authority is known | Fixed (read-only hold) |
| MB-008 | Navigation write amplification | Regression tests added |

### Partially fixed — do not read as complete

| ID | Defect | Status |
|----|--------|--------|
| V159-002 / V160-001 | Silent lost-update race | **Primitive fixed; `logs` converted. 20 other synchronized keys still use the unsafe `STORE.set()` path.** |
| V160-004 | Spreadsheet merge has no conflict detection | **Different-cell case only. Same-cell, structural, and delete-vs-edit still pick a silent winner.** |

`tests/sync-persistence.test.js` now contains a **static debt test** (`STORE_SET_DEBT`) listing every
remaining unsafe synchronized `STORE.set()` call site. It fails if the count grows. Shrink it as
each key is converted; that list is the authoritative to-do.

### V159-002 — root cause and model

`_queueEncryptedWrite()` serialized a complete value **before** acquiring the per-key lock, so a
remote reconcile that committed while the write waited was overwritten by a stale snapshot. The
pending record then adopted the newer revision as its base, so Firebase CAS accepted the stale
value and the remote edit vanished with no conflict.

The fix queues the **operation**, not a precomputed snapshot:

- `_readSyncMutationBase()` — reads the reconciled base **inside** the lock.
- `_queueEncryptedMutation()` — runs `mutator(base)` inside `_serializeKeyMutation`.
- `STORE.mutate(key, fn)` — public API for whole-array/whole-object sync keys.
- `_mergeSpreadsheetEdits()` — three-way merge; `_ssDirtyBase` records what the user started
  from, so only cells they actually touched are applied to the base durable at commit time.

Because the value is now derived from the reconciled base, adopting the current revision is
correct, which closes the revision-binding hole as well.

**Note on doc requirement V159-002 #3:** `_acknowledgePendingSyncRecord` was already correct.
It only advances a base revision when the revision came from acknowledging *our own* superseded
predecessor (`supersededOpIds.includes(opId)`), never from an unrelated operation. Left unchanged
deliberately.

### V159-001 — remote-authority lifecycle

`_syncConfigured` conflated six different states and treated all of them as "no remote workbook."
Replaced with `_remoteAuthority` plus per-key `_remoteDocPresence`:

```
unknown · checking · unconfigured · connecting · authenticating · bootstrapping
ready-present · ready-absent · error · credential-denied · quarantined
```

Only `unconfigured` and `ready-absent` return true from `_remoteStateIsAuthoritativelyAbsent()`.
`initFirebase` now distinguishes "Firebase is genuinely not set up" from "this staff renderer was
denied the owner-only password" — previously indistinguishable, and the staff-specific trigger.

### V159-003 / V159-009 — honest status and durable quarantine

- `_syncKeyStatus()` / `_unsyncedSyncKeys()`: `current · pending · delivering · conflict ·
  quarantined · failed`.
- `_flushSyncDeliveries` treats a skipped delivery as **incomplete**, not success.
- Save All and Force Sync report partial; badge shows `⚠ N not synced`, never `☁ Synced`.
- Quarantine persists to `tmb_sync_quarantine_v1` and is reasserted on restart, reconnect, and
  after the `initFirebase` error path — a relaunch can no longer silently clear it.
- Quarantined keys are **not** subscribed to live snapshots.
- Per-key recovery UI with **Export copies** (local + remote ciphertext, never plaintext) and
  **Retry**, which reconciles one key without reconnecting the whole app.

---

## 2. NOT DONE — still open

| ID | Defect | Why it is not done |
|----|--------|--------------------|
| V160-001 | 20 synchronized keys still use unsafe `STORE.set()` | Partially done; see `STORE_SET_DEBT` |
| V160-004 | Spreadsheet merge has no conflict detection | Needs an operation journal or typed conflict objects |
| V160-005 | Spreadsheet import bypasses the merge path | Needs explicit conflict-preserving replacement |
| V159-004 | Staff cold-start Firebase sync fails | Architectural — see §3 |
| V159-006 | Carrie / Step Up is impersonable | Architectural — see §3 |
| V159-005 | Added profiles are device-local | Depends on §3 transport |
| V159-007 | Legacy plaintext iCloud backup | Needs fixture corpus + your approval on the real file |
| V159-008 | iCloud backup is last-writer-wins | Design decision needed (see §4) |
| V159-010 | Release provenance not rebuildable | `release.sh` never commits the versioned source; see §5.8 |
| V159-011 | Hardening (CSP, ATS, file protocol) | Requires extracting the 12k-line inline script |

### V160-002 — how the fix works, and what to verify live

Not saving the default at load time was necessary but **not sufficient**: the user could still type
into the workbook on screen, and `_stageDirtySpreadsheetSave()` would durably persist it at
revision 0 — recreating the exact poisoned-client condition V160-003 then has to clean up.

`_ssAwaitingAuthority` is set when the workbook on screen is a *fabricated default* shown only
because this Mac has no readable local copy AND remote state is unknown. While set:

- `_stageDirtySpreadsheetSave()` refuses — the single chokepoint every edit funnels through, so
  typing, paste, formatting, structural change, and undo are all covered by one gate.
- `ssOpenProject`, `ssImportFile`, and `ssImportBuildProject` are gated too (defense in depth).
- The home view shows "Checking the cloud…" instead of clickable project cards.

It releases in exactly three ways, matching the audit's allowed conditions: a real workbook arrives
(`_refreshForSyncKey`), remote absence becomes authoritative (`_reevaluateSpreadsheetAuthority()`
after bootstrap), or the user explicitly picks **Start a local workbook anyway**
(`ssWorkLocallyAnyway()`, behind a confirm that names the merge consequence).

An existing *real* local workbook is still editable under unknown authority — that is not a
fabricated default, and V160-003 protects its delivery.

**Verified in both lock orders** by an independent harness:
`type-then-remote` → 0 durable writes, real studio data wins;
`remote-then-type` → 1 durable write, the user's edit lands on real data.

**Live verification required:** on a fresh Mac, open Spreadsheets before Firebase connects, confirm
the read-only card appears, confirm typing is impossible, and confirm the real workbook replaces it
within seconds of sync connecting.

### V160-003 — how the fix works, and what to verify live

Any Mac that ran v1.1.59 may hold a pending record created before it ever saw the cloud
(`baseRevision === 0`). A legacy remote has no `revision` field, so `syncPush`'s transaction also
reads `current = 0`, the CAS check `current !== expectedRevision` **passes**, and the real workbook
is replaced. This was verified as a real defect, not a theoretical one.

The fix holds any `baseRevision === 0` pending record that meets an existing remote document:

- `_classifyPendingAgainstRemote()` returns `poisoned-default` (pending value is byte-identical to a
  fresh `ssCreateDefaultData()`) or `unverified-local` (anything else undecidable). **Both are held.**
- A versioned remote at revision ≥ 1 is *not* held — ordinary CAS already protects it.
- An absent remote is *not* held — a first upload to an empty studio must not be blocked.
- The hold persists in `tmb_sync_recovery_v1` and is reasserted on restart.
- `_scheduleSyncDrain()` refuses the key, so `syncPush` is never reached.
- It surfaces through the existing conflict UI (Use Cloud / Keep This Mac), which already creates an
  encrypted recovery snapshot before applying either side, plus an "Export both copies first" button.

Degradation is safe: if the default-workbook signature check cannot run, classification falls back to
`unverified-local`, which is still held.

**Live verification required (§5.5):** confirm on a real poisoned Mac that the workbook is held, the
warning names Use Cloud as the likely correct choice, Export produces both copies, and choosing
Use Cloud restores the studio workbook and migrates it to schema v2.

---

## 3. V159-004 + V159-006 — the design, and why they are one change

These are not two fixes. They converge on the same root problem:

**The renderer owns the Firebase session.** There are 52 direct Firestore call sites in
`index.html`. `step_up_receipts` is an ordinary sync key in the same studio document. So:

- Staff cannot cold-start sync without the owner password, because the renderer is what
  authenticates (`index.html:3893-3917`, `main.js:1573-1580` gates it to Owner). — V159-004
- Any renderer code can read any studio document, so Step Up guards at `index.html:11304-11318`
  are advisory only. `app-session-start-staff` (`main.js:1418-1422`) accepts a display name with
  no identity proof. — V159-006

Renderer-side guards cannot fix either. The required change:

1. **Move the Firebase session into `main.js`.** Main authenticates; the password never enters a
   renderer. Staff renderers get a session, not a credential.
2. **Proxy all Firestore access over IPC** — `get`, CAS write, and `onSnapshot` as a push channel.
   All 52 call sites become IPC calls.
3. **Immutable user IDs and trusted claims.** Replace display-name-based privilege with a stable
   `userId` in `appSession`. `_requireAppRole` already exists and is the right hook.
4. **Per-staff authentication.** Any profile whose role is not `Front Desk` requires a credential.
   This means **Carrie is locked out until you enrol her passcode** — that is the intended secure
   behavior, but it is a real operational change you must plan for.
5. **Gate `step_up_*` keys in main** on the authenticated role, and tighten `firestore.rules` to
   match, so the trusted layer and the database agree.

**My recommendation: do this as its own release, after v1.1.60 ships the data-loss fixes.**
It rewrites the exact data path whose races were just repaired, and it cannot be validated without
two machines. Shipping both together means that if a device loses data you cannot tell which change
caused it.

---

## 4. Decisions I need from you

1. **V159-008 iCloud** — the doc says prefer immutable per-device snapshots if iCloud Drive cannot
   provide dependable CAS. It cannot. Confirm you want
   `sync-<deviceId>-<timestamp>.json` snapshots with a bounded retention count, replacing the
   single shared `sync.json`.
2. **V159-007 legacy migration** — I will build and test it entirely against fixtures. Before it
   runs against your real
   `~/Library/Mobile Documents/com~apple~CloudDocs/Music Box Internal/sync.json`
   (1724 bytes, modified 2026-06-16), I want your explicit go-ahead, and a copy taken outside
   iCloud first. iCloud version history may retain the plaintext even after replacement.
3. **V159-011 CSP** — dropping `script-src 'unsafe-inline'` means extracting ~11,770 lines of
   inline script to an external file and fixing every inline `onclick=` handler (there are many).
   That is a large mechanical refactor with real regression risk and no test coverage for the UI.
   Confirm you want it in this release rather than the next.
4. **Carrie's passcode** — see §3 item 4.

---

## 5. Operator verification — required before ANY release

I cannot run these. Each needs real hardware, a non-production Firebase project, or your
credentials.

### 5.1 Set up a non-production Firebase project
- [ ] Create a throwaway Firebase project. Never point these tests at production.
- [ ] Deploy `firestore.rules` to it.
- [ ] Configure two Macs (A and B) against it.

### 5.2 Logs — two devices
- [ ] A and B add different logs concurrently → **both survive**.
- [ ] A edits a log while B adds another → **both survive**.
- [ ] Same log edited concurrently → explicit conflict, both copies preserved.
- [ ] Delete vs edit → neither disappears silently.
- [ ] Offline edit on B, reconnect → reconciles without replacing A's work.

### 5.3 Spreadsheets — two devices
- [ ] A edits A1, B edits B1 concurrently → **both cells survive**. *(This is the fix; verify it live.)*
- [ ] Same cell concurrently → conflict or documented merge.
- [ ] Different sheets concurrently → both survive.
- [ ] Structural change vs cell edit → both preserved or explicit conflict.
- [ ] Rapid typing during a remote decode.
- [ ] Open/switch project and switch sheet → **zero** workbook writes.

### 5.4 MB-001 startup race — the release blocker
- [ ] Fresh Mac, never synced, open Spreadsheets **immediately** before Firebase connects →
      **zero default writes**, real workbook loads when bootstrap finishes.
- [ ] Same with a populated legacy revision-zero remote → remote preserved.
- [ ] Airplane mode before bootstrap → zero default cloud-bound writes.
- [ ] Wrong Firebase password → zero default cloud-bound writes.
- [ ] Staff cold start before any owner login → zero default cloud-bound writes.
- [ ] Genuinely unconfigured install → exactly one default write.

### 5.5 Poisoned-client recovery
- [ ] On a Mac that already has a poisoned pending default from v1.1.59, confirm the real remote
      workbook is offered and is **not** overwritten automatically.
- [ ] Restart → recovery remains available.

### 5.6 Quarantine and status
- [ ] Put an invalid workbook in the test remote → spreadsheets quarantines, **logs keep syncing**.
- [ ] Save All reports partial. Force Sync reports partial. Badge shows `⚠ 1 not synced`.
- [ ] **Restart → still quarantined** (this is the new durable behavior).
- [ ] Export copies produces both local and remote ciphertext; no plaintext on disk.
- [ ] Fix the remote, press Retry → key recovers without an app restart.

### 5.7 Update install
- [ ] From a disposable v1.1.59 install with local + cloud test values.
- [ ] Pending/quarantined save **prevents** installation.
- [ ] Successful flush permits it.
- [ ] Relaunch shows the right version; logs and spreadsheets intact locally and remotely.

### 5.8 Provenance (V159-010) — fixes the v1.1.59 gap
- [ ] Commit the version bump **before** building.
- [ ] Tag the exact source state and push the tag to the **public** repo.
- [ ] Verify the advertised commit is publicly retrievable *before* publishing the release body.
- [ ] Build from a clean checkout.
- [ ] Record: source commit → tree → package version → artifact SHA-256 → feed → notarization → tag.

### 5.9 Final gate
- [ ] Every box above checked.
- [ ] You have reviewed the evidence.
- [ ] You explicitly authorize the release.

---

## 6. Files changed

```
index.html                      sync primitive, remote-authority lifecycle,
                                quarantine durability + recovery UI
tests/sync-persistence.test.js  2 corrected races + 16 new tests
```

`main.js`, `preload.js`, `firestore.rules`, the workers, and `package.json` are **unchanged**.
The version is still `1.1.59` — bump it only as part of the provenance procedure in §5.8.
