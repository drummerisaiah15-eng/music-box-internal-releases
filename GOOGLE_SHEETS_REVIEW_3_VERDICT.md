# Verdict on the Revision 3 review

Reviewed against `GOOGLE_SHEETS_SYNC_PLAN.md` (revision 2), the current working
tree, and Google's own reference documentation — fetched, not recalled.

**Summary: the review is right about everything that matters, including one
place where revision 2 states something about the Sheets API that is simply
false. Nothing in it is invented. Where I disagree, it is about scope and
sequencing, not about facts.**

---

## The five P0s

### P0-1 — the Google read/write race. **Valid. This is the one that counts.**

Verified against the `values.batchUpdate` reference. The entire request body is:

```
valueInputOption, data[], includeValuesInResponse,
responseValueRenderOption, responseDateTimeRenderOption
```

There is no revision precondition, no etag, no `If-Match`, and no equivalent of
the Docs API's `WriteControl.requiredRevisionId`. **Google Sheets has no
conditional value write.** Neither does `spreadsheets.batchUpdate` with
`UpdateCellsRequest`.

Revision 2 §3 presents `pull → rebase → write → read back → verify → commit` as
though the readback closes the loop. It does not. Reading back `C` confirms the
cell now holds `C`. It says nothing about whether a `B` existed in between and
was destroyed. The review's interleaving is correct and the write cycle as
specified cannot detect it, let alone preserve it.

The local operation journal and the Firestore lease are both outside Google.
Neither can serialize an edit made in the Sheets UI.

`includeValuesInResponse` collapses the write and readback into one round trip,
which narrows the window. It does not close it. Narrowing a race is worth doing
and is not worth describing as safety.

I wrote revision 2. This was my error, and it is the kind that only shows up as
someone's lost afternoon.

### P0-2 — lease ownership. **Valid, and it catches a contradiction inside my own document.**

Revision 2 §1.1 says the lease is granted on Firestore server time via
`request.time`. Revision 2 §2.1 puts `bridgeOwner` and `leaseExpiresAt` inside
`google_sheet_links`, which is an **encrypted** synced value. Security Rules
cannot read inside ciphertext. The rules could not have enforced the lease the
document claims they enforce.

The fencing point is also right: a lease transaction orders *acquisition*, not
*requests already in flight*. An HTTP request the old holder sent before expiry
can land at Google after a new holder takes over. Google has never heard of the
Firestore lease.

A plaintext coordination document with a monotonic `leaseEpoch`, checked again
before any result is allowed to update Firebase, is the right correction.

### P0-3 — split configuration, checkpoint, outbox, conflicts, lease. **Valid.**

Rewriting a ~500 KB encrypted document per operation is the wrong concurrency
unit, and two Macs appending to it would need a second whole-document merge
protocol underneath the one being built.

The rules point is now even more concretely true than when the review was
written: `knownDataKey`/`writableDataKey` were reduced to a fixed allowlist this
week when lesson check-out was removed. There is currently no path in
`firestore.rules` by which a dynamic `google_link_state_<linkId>` document could
be created at all.

### P0-4 — structural detection. **Valid.**

Dimensions plus a stable `sheetId` genuinely cannot see:

- a row insert paired with a row delete (dimensions restored);
- a merge or unmerge (dimensions never change);
- a move within the range.

Revision 2 dropped revision 1's header fingerprint for good reasons and replaced
it with something strictly weaker while describing the change as an improvement.
Either developer-metadata anchors get designed and proven, or the promise
narrows to "some structural changes are detected" with the gap named.

### P0-5 — conflict lifecycle. **Valid, and one part is a live bug in shipped code.**

`index.html:8163`:

```js
if (merged.length) workbook._conflicts = merged.slice(-MAX_SPREADSHEET_CONFLICTS);
```

At 200 conflicts this silently discards the **oldest unresolved** ones. Those
records are the only surviving copy of a losing value. This is the same failure
family as the normalization bug fixed in `6eedb18`: a conflict channel that
accepts a value and quietly destroys it.

The 32-bit djb2 `_ssConflictId` is a fair catch but should be weighted
honestly: at a full 200 entries the birthday collision probability is roughly
five in a million. Real, cheap to fix, not urgent, and not in the same class as
the eviction.

---

## P1 items

### 10.1 — the `RAW` contract. **Valid. My factual error.**

Google's `ValueInputOption` reference, verbatim: *"RAW — The values the user has
entered will not be parsed and will be stored as-is."*

Revision 2 §1.2 refuses values beginning with `=`, `+`, `-`, `@`, leading zeros,
and date-like text on the grounds that "these change meaning under either input
option." That is true of `USER_ENTERED` and false of `RAW`. Revision 3 must
either allow those strings under `RAW` and verify `userEnteredValue` after the
write, or keep the refusal and label it as a deliberate product policy. It is
not an API constraint and revision 2 should not have implied it was.

### 10.4 — OAuth. **Valid, with one correction to revision 2.**

The seven-day refresh-token expiry is a property of **External + Testing**, not
of personal Google accounts generally. Revision 2 §4 implied the latter.
Internal mode requires the Cloud project *and* every user to sit in the same
Workspace organization — worth confirming before it goes in a plan as an
available option.

### 10.7 — quotas. **Valid.** Centralized scheduling and a global budget belong
in revision 3, and "no latency issues" is not a claim to make without numbers.

### 10.2, 10.3, 10.5, 10.6, 10.8 — **all valid**, none controversial. 10.8 in
particular: Sheets cell data does not identify which collaborator made an edit.
Labelling a Google-origin change with a Music Box profile name would be
fabrication.

---

## Where I push back

Not on facts. On scope, and on one sequencing decision I think is wrong.

**1. Phase -1 is treated as a prerequisite for all Google work. It is a
prerequisite for write-back.**

A read-only mirror creates no new app-side conflict class. It is one more writer
into the merge path that already exists and is already tested. Gating the only
obviously-safe half of this project behind a conflict-resolution UI, durable
resolution markers, a clear-versus-edit redesign, and a full two-Mac matrix
delays the part with no downside. I would build the conflict UI *because the app
needs it today* — not as a Google prerequisite.

**2. "At capacity, pause before accepting a new edit."**

Correct instinct, wrong lever. A studio schedule that stops accepting typing
because a conflict list is full is a worse failure than the one it prevents.
Never evict, raise the cap, refuse the *sync* and say so loudly — but let people
keep working.

**3. §12 and §14 are sized for a different project.**

The review opens by saying not to turn this into an excessive redesign, then
asks for a Firestore emulator suite, deterministic three-actor harnesses, p50/p95
latency instrumentation, and a one-week soak. Much of that is right for Phase 2.
Very little of it is right for a read-only mirror in a two-person studio. I would
take the three-actor tests and the content tests, and defer the emulator suite
until there are dynamic document paths to test.

**4. Developer metadata as row anchors** deserves evaluation, not assumption.
It attaches to rows and columns and does survive insertion — but only for rows
that carry it, which means writing metadata for every row at link time and
maintaining it. That is a real project, not a paragraph in a plan.

---

## What I recommend, in order

1. **Fix the conflict eviction now.** It is a live data-loss path in the shipped
   app and has nothing to do with Google. Small, self-contained, testable.
2. **Build the spreadsheet conflict UI.** Also independent of Google. Conflicts
   are being preserved today with no way to see or resolve them, which is only
   half a feature.
3. **Run the two-Mac matrix.** Outstanding across five rounds of convergence
   fixes now, including the two committed today. Everything else is inference.
4. **Then revision 3** — but it cannot be written until decision 1 below is
   answered, because the whole document changes shape depending on it.

## The decisions this is waiting on

**1. Google write safety — the only one that blocks revision 3.**
Sheets cannot do a conditional write. So: (a) read-only mirroring until a
Google-side preservation mechanism is built and proven; (b) app-to-Google writes
that are manual and explicitly best-effort; or (c) build an Apps Script change
journal and prove it retains the intermediate value.

*Recommend (a).* It delivers the useful half now, promises nothing false, and
leaves (b) and (c) open.

**2. Values-only.** The linked sheet is a colour-block schedule. Text-only sync
will not carry the colours. If the colours mean something operationally, this is
a Phase 3 requirement, not a nice-to-have.

**3. Bridge availability.** Is there a Mac that stays awake? If both sleep
nightly, the leased-bridge design cannot deliver dependable background sync and
the honest options are a paid Firebase plan or accepting sync-when-open.

**4. Scope.** `.../auth/spreadsheets` reaches every sheet the account can see.
`drive.file` is narrower but needs a file picker. Which is worth the extra work?

**5. Real ranges.** 200 × 30 was an estimate. The actual sheets need looking at.

**6. Owner-only link/unlink.** Recommend yes — consistent with every other
privileged action, and it changes nothing about who can edit.

---

## What this document does not claim

- No part of the Google integration has been built, and none should be until
  decision 1 is answered.
- Nothing here has been verified against a live Google Sheet.
- The two-Mac behavioural matrix remains unrun.
- Revision 2 remains the current plan of record and should not be implemented.
