# Google Sheets ↔ Music Box Internal — two-way sync plan (revision 2)

Status: **awaiting approval. Not started.**
Supersedes revision 1, which contained an impossible storage design and assumed
a conflict channel that did not work.

---

## 0. What changed and why

An external review rejected revision 1. It was right on both counts that
mattered, and both were verified here by running the real code rather than
reading it:

- **The conflict channel was broken.** `normalizeSpreadsheetWorkbook()` validated
  `_conflicts` and then returned an object built from `activeProject` and
  `projects` alone. A conflict went in, nothing came out. Every preserved losing
  value was destroyed by the next save. Fixed in `6eedb18`, with the regex test
  that had passed throughout replaced by one that runs the normalizer.
- **The storage design was arithmetically impossible.** Revision 1 put two
  ~600 KB snapshots in one synchronized key. `MAX_SYNC_PLAINTEXT_BYTES` is
  620,000. It could never have been stored.

Revision 1 also promised formatting sync that its own write path could not
perform, left bridge ownership implicit, and relied on a header fingerprint for
structural detection that both false-positives and false-negatives.

---

## 1. Decisions (§8 deliverable)

### 1.1 The single bridge — a leased bridge Mac

Exactly one writer per link. Two options were considered:

| | Cloud worker | Leased bridge Mac |
|---|---|---|
| Reliability when Macs sleep | Better | Worse |
| Firebase plan required | **Blaze (paid)** | Spark (current) |
| New infrastructure to operate | Yes | No |
| Secrets outside the studio's Macs | Yes | No |

**Chosen: leased bridge Mac.** The studio is on the Spark plan; Cloud Functions
would require moving to Blaze, and a cloud worker means the Google refresh token
lives somewhere other than a Mac Isaiah controls. For two Macs in one building,
that cost is not justified.

The lease lives in a Firestore document, keyed by `linkId`, and is granted on
**server time only** — `request.time`, never client clocks, which is the same
mistake the iCloud snapshot ordering already makes and which must not be
repeated here. Lease term 90 seconds, renewed every 30. A Mac that cannot renew
stops writing immediately and does not resume until it re-acquires. Only the
lease holder may call Google's write API; every Mac may read.

**Failover is a required test, not an assumption:** lease expiry, holder crash
mid-push, two Macs racing acquisition, and a woken Mac discovering it lost the
lease while it had operations queued.

### 1.2 Supported cell types and the formatting contract

**First release synchronizes typed cell content only. No formatting, in either
direction.** Revision 1 promised background, text colour and bold round-trip
while writing through `values.batchUpdate`, which writes values and nothing
else. That promise is withdrawn rather than half-kept.

Read (Google → app): all types are read and displayed. `spreadsheets.get` with a
narrow field mask returns `userEnteredValue`, `effectiveValue` and
`formattedValue` in one response, so typed information is retained in the
checkpoint even though the app's cell model is text.

Write (app → Google): permitted **only** where the Google cell's
`userEnteredValue` is a string or blank, and the new value would not be
reinterpreted. Written with `RAW`, so nothing is reparsed.

Refused, read-only in the app, and labelled as such:

- any formula-backed cell;
- numbers, booleans, dates, currency, errors;
- any new value beginning with `=`, `+`, `-`, `@`, or matching a leading-zero or
  date-like pattern — these change meaning under either input option;
- merged ranges, data validation, protected ranges.

On a linked sheet, the app's fill/bold/colour controls are disabled with an
explanation. Google-side formatting is never touched, because the app never
issues a range overwrite — only per-cell value updates.

### 1.3 Bounded range and structural changes

A link targets `spreadsheetId` + **numeric `sheetId`** (a tab title can be
renamed; the gid cannot) + an explicit bounded A1 range. Never a whole tab:
Google tabs carry thousands of empty default rows, and comparing that grid to
the app's 500-row limit would reject ordinary sheets.

Limits at link time, refused with the specific number: **200 rows × 30 columns,
6,000 cells** within the linked range.

Structural changes are **not synchronized in any phase of this plan.** Detection
is by comparing the linked range's grid dimensions and the tab's `sheetId` on
every pull. Any row/column insertion, deletion, merge or unmerge inside the
range, any tab deletion, or any permission loss **pauses the link, keeps both
copies untouched, and asks for an explicit re-link.** The header fingerprint from
revision 1 is dropped: an ordinary header edit falsely paused it, and some
insert/delete pairs slipped past it.

### 1.4 First link is never silent

Linking previews the differences and requires an explicit choice: take Google's
values, keep the app's, or cancel. No automatic winner on first connect.

---

## 2. Data model, with size math

Revision 1's error was putting bulk state in a synchronized key. Configuration,
checkpoint, and operations are now separated.

### 2.1 Synchronized configuration — `google_sheet_links`

Small, shared, visible. New sync key; requires adding to `SYNC_BASE_KEYS` **and**
`baseDataKey()` in `firestore.rules` (the parity test enforces both).

```js
{
  linkId, spreadsheetId, googleSheetId, googleSheetTitle, range,
  projectId, appSheetId,
  mode: 'read-only' | 'two-way-values',
  status, pausedReason,
  bridgeOwner, leaseExpiresAt,
  lastSuccessfulPullAt, lastSuccessfulPushAt,
  pendingOperationCount, conflictCount
}
```

≈400 bytes per link. Twenty links ≈8 KB against a 620,000-byte plaintext limit.

### 2.2 Per-link state — separate encrypted documents

One document per link, not shared with the workbook:

```text
google_link_state_<linkId>
  checkpoint        one common base for the linked range
  typeMetadata      per-cell: isFormula, valueType
  outbox            durable operation journal
  conflicts         unresolved, with both values
  ackMarkers        bounded replay guards
  googleVersion     last verified signal
```

**Budget:** 6,000 cells × ~60 bytes of value + type metadata ≈360 KB
plaintext. Base64 ciphertext expands ~1.37× ≈493 KB, against
`MAX_SYNC_CIPHERTEXT_CHARS` 880,000 and Firestore's 1 MiB document limit.
Outbox and conflicts are capped so the total cannot pass 500 KB plaintext;
at 80% the link pauses and says so rather than silently dropping records.

One checkpoint, not two. Revision 1's second snapshot is unnecessary: the outbox
carries each operation's own recorded base.

---

## 3. The write cycle

Snapshot-diffing cannot guarantee no lost edit — a Google user can edit between
the pull and the write. Every app edit becomes a durable operation:

```text
operationId, linkId, deviceId, profileName, googleSheetId, target,
baseValue (typed), desiredValue (typed), createdAt,
state: queued | applying | acknowledged | conflicted | failed,
attempts, lastError, acknowledgedAt
```

Cycle, in order, with no step skippable:

1. **Acquire or renew the lease.** No lease, no write.
2. **Pull** the exact bounded range.
3. **Rebase** every queued operation against Google's current cell, comparing the
   operation's recorded base.
4. **Split**: uncontested operations proceed; contested ones become conflicts and
   are removed from the batch.
5. **Write** one bounded batch, `RAW`, per-cell only.
6. **Read back** the touched cells.
7. **Verify** the typed values match what was intended.
8. **Commit** the verified result into the app and Firebase.
9. **Acknowledge** operations and advance the checkpoint — **only** after both
   systems confirm. An unverified write never advances the base.

Same cell changed on both sides: **both values kept, no automatic winner.** This
differs deliberately from the app's internal two-Mac merge, which picks a
deterministic winner. Between two Macs the loser is recoverable in-app; a
Google-side value overwritten by the app is gone from a system this app does not
control.

---

## 4. OAuth

- Desktop flow with PKCE, loopback redirect, mirroring `main.js:178-330`.
- Tokens in the main-process vault, never in the renderer.
- **Scope: `https://www.googleapis.com/auth/spreadsheets` only.**
  `drive.metadata.readonly` is dropped — Google classifies it as restricted, and
  `modifiedTime` is file-wide rather than per-tab, so it would not have told us
  what we needed. Polling the bounded range directly is simpler and narrower.
- A desktop client secret is not confidential. The vault is sensible local
  protection, not a security boundary; the plan does not claim otherwise.
- External/Testing refresh tokens expire after 7 days. The UI must show a clear
  reconnect state, not a silent stall. If the studio has Workspace, an Internal
  app removes this entirely and is the better answer.
- Polling: 60s foreground, 10min background, none while offline. **This is
  eventual sync, not real-time**, and the UI must say so.
- Truncated exponential backoff with jitter on 429 and retryable 5xx. Bounded
  timeouts, cancellation on unlink, explicit revocation handling.

---

## 5. Phases and gates

### Phase −1 — Repair and certify the app's own merging *(no Google code)*

1. ~~Conflicts survive normalization~~ — **done, `6eedb18`.**
2. **Spreadsheet conflict UI**: both values, their source, explicit resolution,
   and a persisted resolution marker so a stale peer cannot recreate it.
3. **Clear-versus-edit becomes a resolvable conflict**, not a thrown error that
   the save path then swallows by restoring the remote snapshot.
4. **Run the two-Mac matrix** — still outstanding across four rounds of
   convergence fixes.

**Nothing Google-related starts until this passes.**

### Phase 0 — Confirm decisions in §1 with Isaiah, complete Google Cloud setup.

### Phase 1 — Read-only mirror. Write code absent, not flag-disabled.
Gate: 3 days on real sheets including formulas, restart, offline, token expiry,
permission loss, tab rename, tab deletion, deliberate structural pause.

### Phase 2 — Queued value write-back.
Gate: 1 week two-way on two Macs, plus deliberate conflict and recovery drills.

### Phase 3 — Formatting, only if separately field-masked and modelled by both.
### Phase 4 — Structural sync. A separate project, probably never.

---

## 6. Test matrix

Behavioural, against source **and** the exact signed DMG. Static regex assertions
do not count as proof of persistence — that is precisely how the conflict-loss
bug survived.

**Content:** empty, long, Unicode, emoji, tabs, newlines; leading zeros,
apostrophe-prefixed, strings starting `=`, HTML-like; numbers, decimals,
booleans, dates, currency; formula plus computed value with the formula intact
afterwards; unsupported types fail visibly without altering either copy.

**Persistence:** Google edit survives app restart; app edit survives both;
offline edits queue and deliver; crash after pull, after commit, during push,
after the Google write but before acknowledgement; retry is idempotent.

**Concurrency:** different cells both survive; same cell keeps both and waits;
clear-versus-edit both directions; two Macs plus Google; lease contention;
holder crash and failover with no duplicate push; stale Mac cannot resurrect a
resolved conflict.

**Lifecycle:** tab rename stays linked via gid; tab/file deletion, permission
downgrade, revoked OAuth; structural change pauses *before* applying anything;
unlink while offline or with queued operations; relink to a different tab cannot
replay old operations.

**Network:** 401/403, 404, 429, 5xx, timeout, malformed and oversized responses;
backoff limits; several links within Google quota and every size limit; state
near maximum still preserves conflicts and queued operations, or refuses safely.

---

## 7. Rollback

Every phase is a commit range on a tagged release. Unlinking stops network work
immediately and leaves both copies untouched. The final encrypted checkpoint and
any unresolved operations are **kept**, with a separate explicit purge once
Isaiah confirms no recovery is needed.

---

## 8. Unresolved decisions for Isaiah

1. **Workspace or personal Google account?** Workspace allows an Internal OAuth
   app and removes the 7-day token expiry. This materially changes daily use.
2. **Is the text-only contract acceptable for the first release?** Formatting and
   structural changes will not sync. If the schedule's colour blocks must sync,
   the answer changes and Phase 3 becomes mandatory rather than optional.
3. **Which sheets, and what ranges?** The 200×30 limit needs checking against the
   real sheets before anything is built.
4. **Is a bridge Mac acceptable?** Google sync stalls when that Mac is asleep or
   closed. The alternative costs a paid Firebase plan.
5. **Should linking be Owner-only?** Consistent with other privileged actions,
   but it means Carrie cannot link a sheet herself.
