# Google Sheets ↔ Music Box Internal — two-way sync plan

Status: **approved, not started.** Say "start Phase 0" and execution begins at §6.

Decision on record: staff edit in **both** Google Sheets and the app, and both stay
in sync. That choice forces OAuth — publish-to-web and CSV download are read-only
and cannot satisfy it.

---

## 1. What makes this tractable

Google becomes one more editor alongside the two Macs, not a special case. The
operation model built for P0-1 already does the hard part:

| Existing piece | Reused as |
|---|---|
| `_deriveSpreadsheetOperations(base, next)` | turns "Google changed" into operations |
| `_applySpreadsheetOperations(target, ops)` | lands them, recording conflicts deterministically |
| `pending.baseCiphertext` (rebase base) | same idea as the stored Google snapshot |
| `_conflicts` on the workbook | where a Google-vs-app collision is recorded |
| `editedBy` attribution | Google edits are attributed to `Google Sheets` |

The sync loop is therefore:

```
poll → Google now
ops  = derive(lastGoogleSnapshot, googleNow)      // what Google did
apply(appWorkbook, ops)                            // conflicts recorded, not guessed
push = derive(lastPushedAppSnapshot, appWorkbook)  // what the app did
batchUpdate(google, push)                          // value-only cells
store both snapshots
```

Both snapshots are per-linked-sheet and encrypted at rest like everything else.

---

## 2. The three hazards, and the rule for each

These are the reasons this is staged rather than shipped in one go. Each has a
rule that must hold from the first line of code, not be retrofitted.

### H1 — Formulas (destroys data silently)

A cell holding `=SUM(B2:B10)` returns a *number* from the values API. Writing
that number back replaces the formula permanently, and nobody notices until a
month later when the total stops updating.

**Rule:** every read requests both `UNFORMATTED_VALUE` and `FORMULA`. Any cell
whose FORMULA rendering starts with `=` is marked formula-backed. Formula-backed
cells are **read-only in the app** — displayed, greyed, never pushed back, and
never editable. A push that would touch one is a bug, and is asserted against in
tests.

### H2 — Inserted rows and columns (corrupts everything below)

The app addresses cells as `row,col`. Inserting a row in Google shifts every
address beneath it, so a naive diff sees hundreds of changes and would replay
that shift into the app — or back into Google.

**Rule:** before diffing, compare the sheet's row/column *count* and a fingerprint
of the frozen header row and first column. If either moved, **stop syncing that
sheet, surface it, and require an explicit re-link.** Never diff across a
structural change. Silent corruption is worse than a paused sync.

### H3 — Fidelity gap (loses formatting)

Google has merged ranges, data validation, notes, conditional formatting,
multiple tabs, 18k+ columns. The app's cell is `{v, bg, tc, b, rs, cs}` and it
caps at 500 rows × 100 cols, 10,000 non-empty cells, 600 KB.

**Rule:** at link time, refuse anything that does not fit and say exactly why
("this sheet has 1,400 rows; the limit is 500"). Round-trip only `v`, `bg`, `tc`,
`b`. Everything else in Google is preserved by *not writing to those cells* —
the app never issues a full-range overwrite, only per-cell updates for cells it
actually changed.

---

## 3. What Isaiah must do (Phase 0 — the only part I cannot do)

1. **Google Cloud project** — console.cloud.google.com → new project, e.g.
   `music-box-internal`.
2. **Enable APIs** — Google Sheets API, Google Drive API.
3. **OAuth consent screen** — External, Testing mode. Add each staff Google
   account as a test user. Scopes:
   - `https://www.googleapis.com/auth/spreadsheets` (read + write)
   - `https://www.googleapis.com/auth/drive.metadata.readonly` (change detection)
4. **OAuth client** — type **Desktop app**. Produces a client ID and secret.
5. Hand me the **client ID** only. The secret goes into the vault through the
   app's Settings screen; I never see it, exactly as with Firebase.

Note on Testing mode: refresh tokens expire after 7 days. Fine for the trial. If
this becomes permanent, the consent screen needs publishing (or an Internal app
if the studio has Google Workspace — which removes the expiry entirely and is
the better answer if available).

---

## 4. Architecture

### 4.1 Where the code goes

| Concern | Location | Why |
|---|---|---|
| OAuth loopback + PKCE | `main.js`, mirroring the Microsoft flow at `main.js:178-330` | tokens never enter the renderer |
| Token storage | `_loadSecretVault()` under `google_oauth` | same protection as Firebase creds |
| API calls | `main.js` via `_boundedHttpsGet`-style helpers | renderer has no network reach; domain allowlist enforced |
| IPC | `_secureHandle('google-sheets-*')`, Owner-only for link/unlink, any session for read | matches the credential model settled today |
| Preload | new `electronGoogleSheets` bridge | consistent with `electronMicrosoft` |
| Diff / merge / conflicts | `index.html`, reusing the operation model | no second merge implementation, ever |

Allowlisted hosts: `oauth2.googleapis.com`, `sheets.googleapis.com`,
`www.googleapis.com`. Nothing else.

### 4.2 Data model

New sync key `google_sheet_links` (encrypted, synced, added to
`SYNC_BASE_KEYS` **and** `baseDataKey()` in `firestore.rules` — the parity test
in `tests/sync-persistence.test.js` enforces both):

```js
{
  linkId, spreadsheetId, googleSheetName,
  projectId, sheetId,              // the app-side target
  lastGoogleSnapshot,              // for deriving Google's operations
  lastPushedAppSnapshot,           // for deriving the app's operations
  rowCount, colCount, headerFingerprint,  // H2 structural guard
  formulaCells: ['3,4', ...],      // H1 read-only set
  lastSyncedAt, lastModifiedTime, status
}
```

Snapshots are bounded by the existing 600 KB workbook limit; two snapshots per
link is the storage cost and is checked at link time.

### 4.3 Polling

Drive `files.get?fields=modifiedTime` is one cheap call. Only when
`modifiedTime` moves do we pull values. Poll every 60s while the Spreadsheets
page is open, every 10 minutes otherwise, and never when the app is offline —
the same "ration the writes" discipline used for presence.

---

## 5. Phases and their gates

Each phase ends with a signed DMG and a defined thing to watch. **No phase
starts until the previous one has run against real sheets for the stated time.**

### Phase 1 — Read-only mirror (write-back physically absent)

- OAuth flow, token storage, refresh.
- Link a Google sheet to an app sheet; enforce §2 limits at link time.
- Poll, diff, apply Google's operations into the app.
- Formula cells detected and marked read-only.
- Structural change detection pauses the link and says so.
- **Write-back code does not exist yet.** Not disabled by a flag — absent.
- UI: "Linked to Google Sheets · updated 2 minutes ago", and a visible paused
  state with the reason.

**Gate:** runs against your real sheets for **3 days** with no incorrect data
appearing in the app, and at least one deliberate structural change correctly
pausing the link.

### Phase 2 — Write-back, value cells only

- Push app operations to Google via `values.batchUpdate`, per-cell only.
- Hard refusal to write any formula-backed cell.
- Same-cell collisions recorded in `_conflicts`, resolved by the existing UI.
- Every push is preceded by a pull, so the app never overwrites unseen work.

**Gate:** two-way editing for **1 week** with no lost edit and no destroyed
formula. A restore-from-Google-history drill is performed once, deliberately,
to prove recovery works.

### Phase 3 — Decide on structural changes

Either implement row/column insertion tracking with a stable key column, or
document that structural edits require a re-link. **The default is to stop at
Phase 2** and accept re-linking. Phase 3 is where sync tools go wrong, and the
studio may simply not need it.

---

## 6. Execution order on "start"

1. Read `main.js:178-330` (Microsoft loopback + PKCE) and mirror it exactly.
2. `google-oauth-begin`, `google-oauth-exchange`, `google-oauth-refresh`,
   `google-oauth-clear` in `main.js`; token in the vault; Owner-only to link.
3. `electronGoogleSheets` in `preload.js` — no token ever crosses.
4. `googleSheetsGet(spreadsheetId, range)` in `main.js` requesting both
   `UNFORMATTED_VALUE` and `FORMULA`; bounded response; allowlisted host.
5. `_googleSheetToWorkbookCells(values, formulas)` in `index.html` + limit
   enforcement, with tests for every refusal message.
6. `google_sheet_links` key: `SYNC_BASE_KEYS`, `firestore.rules`, parity test.
7. Link UI in Spreadsheets, Owner-only.
8. Poll loop with the modifiedTime check and the offline/visibility rationing.
9. Structural guard (§2 H2) — **written before the first diff is applied**.
10. Wire Google's operations through `_applySpreadsheetOperations`, attributed
    to `Google Sheets`.
11. Tests: limits, formula protection, structural pause, Google-vs-app conflict,
    attribution, token refresh, and that no write path exists yet.
12. Signed DMG, Phase 1 gate begins.

---

## 7. Rollback

Every phase is one commit range on top of a tagged release. Unlinking a sheet
deletes only the link record — the app's copy and the Google copy both remain
untouched. There is no migration to reverse, and no state that outlives an
unlink.

---

## 8. Honest risks

- **Testing mode tokens expire weekly.** Staff will be asked to reconnect until
  the consent screen is published or moved to Internal.
- **Google API quotas** are generous but not infinite; the modifiedTime gate is
  what keeps us far below them.
- **This is the largest feature in the project.** Phase 1 is roughly the size of
  everything built on 2026-08-05 combined. Phase 2 is smaller but carries all
  the data-loss risk.
- **Two-way sync between systems with different data models always loses
  something.** The rules in §2 decide *what* it loses, deliberately, instead of
  finding out later.
