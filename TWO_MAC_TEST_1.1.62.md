# Two-Mac test — 1.1.62

Everything here has passed unit tests and **none of it has ever run on a real
Mac**. The point of this pass is to find what the tests could not.

Firestore and local data are both disposable, so break things deliberately.

---

## Before you start

1. Install 1.1.62 on **both** Macs. It is signed but **not notarized** — first
   launch needs right-click → Open, or:
   `xattr -dr com.apple.quarantine "/Applications/Music Box Internal.app"`
2. Launch both, confirm both sync (badge reads **Live**).
3. **Only then** paste the new `firestore.rules` (already on your clipboard) into
   Firebase Console → Firestore → Rules → Publish.

Deploying the rules first will break the older build. Installing first costs
nothing.

> Keep the Console open on Firestore → Data throughout. Most of what matters is
> visible there as documents appearing.

---

## 1. The migration — the one that can lose everything

| | Check | Expect |
|---|---|---|
| 1.1 | Open Spreadsheets on Mac A | Toast: "Spreadsheets now store each project separately…" |
| 1.2 | Firebase Console → `musicbox/<code>/data` | One `spreadsheet_proj_…` document **per project**, plus `spreadsheets` |
| 1.3 | Open `spreadsheets` in the Console | It is now an **index** — `schema: 2`, a list of project ids. No sheets inside |
| 1.4 | Every project still opens, every cell still there | Nothing missing, colours intact |
| 1.5 | Quit and relaunch Mac A | Same workbook; **no second migration toast** |
| 1.6 | Now open Spreadsheets on Mac B | Projects arrive; **no** migration toast (already migrated) |

**Stop and tell me if:** a project disappears, the toast fires twice, or the
`spreadsheets` document still contains `sheets`.

## 2. Per-project isolation — the reason for all of this

| | Check | Expect |
|---|---|---|
| 2.1 | Mac A edits project 1, Mac B edits project 2, at the same time | Both land. No conflict, no "sync error" |
| 2.2 | Console: watch which documents change | **Only** the two project docs. `spreadsheets` does **not** change |
| 2.3 | Type a single character in one cell, watch the Console | Exactly one document updates. The index stays still |

2.3 is the one I'd most like confirmed — the index was being rewritten on every
save until a test caught it, and that is the bug most likely to have a twin.

## 3. Creating and deleting projects

| | Check | Expect |
|---|---|---|
| 3.1 | Mac A creates a project | New `spreadsheet_…` doc, **then** the index updates |
| 3.2 | It appears on Mac B | Within a few seconds |
| 3.3 | Mac A deletes a project | It vanishes on both |
| 3.4 | Console: the deleted project's document | **Still there.** Deletion is a tombstone in the index, not a delete |
| 3.5 | Relaunch both | It stays deleted — does not come back |
| 3.6 | Delete on A while B has that project **open** | B is moved out cleanly, not stuck on a dead project |

## 4. Same-cell collisions and the conflict dialog

Never clicked by a human. Expect rough edges.

| | Check | Expect |
|---|---|---|
| 4.1 | Both Macs type **different text into the same cell** at the same moment | Both converge on one value; an amber **"1 unresolved conflict"** banner appears |
| 4.2 | Click **Review** | Dialog names project · sheet · cell, shows both values and what they diverged from |
| 4.3 | Pick a side | Cell takes that value; the conflict clears; **"All spreadsheet conflicts resolved"** |
| 4.4 | Check the other Mac | Same result — the resolution travelled |
| 4.5 | Make **three** conflicts, resolve one | Dialog stays open on the remaining two |
| 4.6 | Quit both, relaunch, make a conflict, resolve on A while B is **closed**. Open B | The conflict does **not** reappear on B |

4.6 is the stale-peer case. It is the one I would least trust.

## 5. Sheet activity — Today / 7 days / All

| | Check | Expect |
|---|---|---|
| 5.1 | Edit some cells, open the right-hand activity panel | Switcher shows **Today · 7 days · All**, Today selected |
| 5.2 | Chips read "N changes · last …" | Counts only today's edits |
| 5.3 | Click **All** | Count goes up (older edits included) |
| 5.4 | Click a chip | Only that person's cells highlight — as many as the count says |
| 5.5 | On **All**, highlight someone who last edited days ago, then switch to **Today** | Highlight clears; the grid does **not** stay dimmed |
| 5.6 | Click an old cell with Today selected | Bottom line still names who changed it and when |
| 5.7 | Relaunch | The window you chose is remembered |

## 6. The things I changed that you did not ask about

| | Check | Expect |
|---|---|---|
| 6.1 | Schedule page | **No** "Check-Out Status" card anywhere — list or calendar view |
| 6.2 | Add two log entries on the **same day**, watch both dashboards | Newest stays newest. No flicker to an older entry and back |
| 6.3 | Add a log on A | Appears on B and **stays** put |
| 6.4 | Cell with long text | Does **not** expand the row; text truncates and the full value shows in the bar under the colours |
| 6.5 | Double-click a cell with text, click mid-word | Caret lands mid-word — no wiping the cell to retype |

6.2 is the flicker you reported. 6.4/6.5 are the ones I got wrong twice.

## 7. Deliberate abuse

| | Check | Expect |
|---|---|---|
| 7.1 | Pull Wi-Fi on B, edit both Macs, reconnect | Both sets of edits survive |
| 7.2 | Quit B mid-edit (⌘Q while typing), relaunch | The edit is there or cleanly absent — never a half-written sheet |
| 7.3 | Import a spreadsheet far too big | Refused **before** importing, naming its cell count. Nothing partially imported |
| 7.4 | Fill one project past ~75% | Blue capacity notice. It should reflect **that project**, not all of them |
| 7.5 | Switch profiles (Carrie ↔ Elizabeth ↔ Step Up) | No password prompt anywhere. Ops & Events and Step Up stay passwordless |

---

## What to send me

For anything that fails: which Mac, what you did, what you saw, and a screenshot
of the Firebase Console `data` collection at that moment. The document list is
usually enough to tell me what happened.

Also worth telling me even if nothing fails: **how many projects and roughly how
many filled cells** the real workbook has. That decides whether 9,000 cells per
project is comfortable or tight.
