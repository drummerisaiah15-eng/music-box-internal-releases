# Music Box Internal 1.3.7 — what to test

**Build:** `Music-Box-Internal-1.3.7-arm64.dmg`
`sha256 2a56d07b0f8cdf97457d104851761eb8bc3183ba82e5e28faa36350edb16bb64`

Supersedes `TESTING-1.3.4.md` and `TWO_MAC_TEST_SCRIPT.md`, both of which predate
everything below. Part 1 is one Mac. Part 2 needs both, in the same room, with a
timer.

> [!IMPORTANT]
> **Install 1.3.7 on BOTH Macs before either one opens a project with a Google
> dropdown.** 1.3.x writes two new keys into the shared project document, and an
> older build refuses the whole workbook and quarantines that project — silently.
> The same applies to any project with more than 25 sheets.

> [!IMPORTANT]
> **Signed, not notarized.** Right-click → Open, then Open again. Gatekeeper will
> warn; that is expected. Verified before handover: `codesign --verify --deep
> --strict` passes on the app and the DMG, hardened runtime on, Team ID
> `MULN9RP9V5`, and the packaged `Contents/Resources/index.html` hashes
> identically to the source.

Use the throwaway Firebase project (`musicbox-testing-01`), not production.
Report failures by number.

---

## What is different about this round

Everything below was verified only by executing sliced functions in a sandbox.
**Four builds, 747 tests, and zero minutes of real runtime on two Macs.** Every
defect you found yourself last time — the false hold, the "25-sheet limit" on a
six-tab project, dropdowns not importing — was invisible to the test suite. So
the checks below are written around *using* the app, not around confirming that
a fix compiles.

Three areas are new enough to deserve real suspicion: **§C (what happens when a
save fails)**, **§B7–B9 (typing while Google syncs)** and **§E3 (logging out)**.
None of the three has ever run outside a harness.

---

# Part 1 — one Mac

## A. Google import

| | Check | Expect |
|---|---|---|
| A1 | Import a sheet that has a **dropdown** column (the Absence Tracker shape) | The cells become dropdowns |
| A2 | Click one | Options are **readable** — coloured or white chips, never grey-on-grey |
| A3 | Pick an option, quit, reopen | The choice stuck and the dropdown is still a dropdown |
| A4 | In Google, add an option to that rule, then sync | The new option appears here |
| A5 | In Google, remove the dropdown from a column, then sync | It stops being a dropdown here |
| A6 | Import a sheet with very narrow and very wide columns | Imports; widths are clamped, nothing is refused |
| A7 | Import a project with 6 tabs while you already have several projects | No "exceeds the 25-sheet limit". If it *is* refused, the message names the real total across all projects |

**A2 is the one to look at first.** Every option chip rendered unreadable grey on
grey in 1.3.6 — it was the first thing anyone would have seen.

## B. Google sync, day to day

This is where 1.3.5 was unusable and where most of the work went.

| | Check | Expect |
|---|---|---|
| B1 | Edit a cell here, don't sync yet. In Google, **move one lesson to a different slot**. Sync | Merges normally. **No "tab NOT merged" banner** |
| B2 | Same, but **swap two people** between slots in Google | Same — no hold |
| B3 | Same, but drag one booking into an adjacent empty cell | Same — no hold |
| B4 | Edit a cell here. In Google, **insert a row** above it. Sync | The tab **IS** held, with a banner naming it |
| B5 | Same with a **deleted row**, and again with an **inserted column** | Held each time |
| B6 | With no local edits at all, insert a row in Google and sync | **Not** held — it just merges |
| B7 | Start typing in a cell and keep typing while a sync runs (or hit "Sync now" then immediately type) | Your text is not disturbed, the grid does not rebuild under the cursor, and the first character you typed is not replaced by the cell's old contents |
| B8 | After B7, check the activity/attribution panel | Cells **Google** changed are not credited to whoever was typing |
| B9 | Leave the Spreadsheets page while a project is open, work elsewhere for 10 minutes | Nothing syncs in the background from a page you are not on |

**B1–B3 are the headline.** Rescheduling a lesson held the tab 100% of the time
in 1.3.5, permanently, and the only way out discarded one side wholesale.

**B4–B6 are the other half.** If B1–B3 pass but B4–B6 also stop holding, the
protection is gone and that is worse than the bug.

### Held-tab recovery (only reachable after B4 or B5)

| | Check | Expect |
|---|---|---|
| B10 | With a tab held, click **Keep this Mac's** | Toast says it kept yours and is syncing again; the banner row disappears |
| B11 | Set up another hold, click **Take Google's**, confirm | The tab matches Google. **Check a merged/joined cell region** — nothing is blanked |
| B12 | After either, look at the toasts | One message, not two contradictory ones. Never "Already up to date with Google" next to a success |
| B13 | Set up a hold, then **delete that tab in Google**, then sync | The banner row clears itself instead of sitting there with two dead buttons |

## C. When a save fails

New behaviour and the least-exercised area in the build. The easiest way to
trigger a refusal is to paste far more content than a project can hold.

| | Check | Expect |
|---|---|---|
| C1 | Paste enough to be refused | A red banner: "These changes are not saved yet". **Your work is still on screen** |
| C2 | Look at where you were | You are **not** thrown back to the project list |
| C3 | Keep typing for a while | You get **one** warning, not one per keystroke, and the app stays responsive |
| C4 | Undo the paste, wait a few seconds | The banner clears itself and the work saves |
| C5 | While the banner is up, try to **quit** | It refuses and offers to retry — correctly, the work really is unsaved |
| C6 | Fix the problem, then quit | Quits normally and promptly. It must **not** keep refusing after the data is safe |
| C7 | After C6, reopen | Everything you typed is there |

**C7 is the test.** The whole point of this change is that a refused save no
longer eats what you typed.

## D. Projects and sheets

| | Check | Expect |
|---|---|---|
| D1 | Open a project, add a sheet | The header subtitle updates — "2 sheets", not "1 sheet" |
| D2 | Delete a sheet | Subtitle updates again, and matches the project card on the home view |
| D3 | Create projects up to the limit | The 26th is refused **before** the card appears, with a message about projects |
| D4 | After D3, quit and reopen | No half-created ghost project, and no project that vanished |

---

# Part 2 — both Macs

Both on 1.3.7, both signed in, both pointed at the throwaway Firebase project.
Call them **A** and **B**. Work through in order; several tests depend on the one
before.

## E. Profiles

| | Check | Expect |
|---|---|---|
| E1 | On **A** (Elizabeth's), at the login screen, add a profile. Then sign in as Elizabeth | Toast: profiles added while signed out are now shared |
| E2 | Watch **B** | The profile appears in its login list within seconds |
| E3 | On **B**, click **Log Out** and leave it sitting on the login screen. On **A**, add another profile and sign in to publish it | — |
| E4 | Sign back in on **B** | The profile from E3 **is there** |
| E5 | On **B**, add a profile at the login screen. On **A**, publish a different change. Now sign in on **B** as Elizabeth | Both profiles survive — B's local one and A's published one |
| E6 | Check **A** after E5 | Nothing has disappeared from A's list |
| E7 | Remove a profile on **A** | It goes on **B** and stays gone after both relaunch |

**E3–E4 is the one that mattered.** Logging out left the listeners running, so a
directory update arriving while signed out was consumed and dropped forever — and
that Mac would later publish its stale copy and delete the profile everywhere.

**E5–E6 is its repair.** Re-applying used to destroy a profile added at the login
screen and then publish the deletion.

## F. Simultaneous editing

| | Check | Expect |
|---|---|---|
| F1 | Both open the same project. Type in **different cells** at the same time | Both land, no conflict, both Macs converge |
| F2 | Both type in the **same cell** within a few seconds | A conflict is recorded; both Macs show the **same** surviving value |
| F3 | Resolve the conflict on **A** | It clears on **B** too, and does not come back after either relaunches |
| F4 | On **A**, delete rows from the bottom of a sheet. At the same time on **B**, type into a row near the bottom | **Both survive.** The sheet grows to fit and saves cleanly — no error, no eject |
| F5 | On **A**, delete a project. On **B**, keep typing in a different project throughout | The project stays deleted on both, and does not reappear after relaunching either |
| F6 | Repeat F5 but with a save failing on **B** first (paste something oversized, then have A delete a project) | Still stays deleted |

**F4 is the collision that caused most of the real damage.** One person tidying
the schedule while another types near the bottom used to refuse the save and
discard the typing.

**F5–F6 is a deletion coming back from the dead.** A stale Mac would republish
the project above the tombstone and it would return on both machines.

## G. Google, both Macs

| | Check | Expect |
|---|---|---|
| G1 | Both Macs have the same linked project open. Change a cell in Google, let both auto-sync | Both take it, no conflict, no duplicate |
| G2 | Change a cell in Google **and** the same cell on **A**, then sync both | Conflict recorded once, same survivor on both |
| G3 | Insert a row in Google while **A** has an unsent edit and **B** has none | **A** holds that tab; **B** merges it normally |
| G4 | Resolve A's hold with **Keep this Mac's** | A syncs again and B is unaffected |

---

## H. Things that must still work

Quick sweep — these are not new, but they are what the fixes could have broken.

| | Check |
|---|---|
| H1 | Sign in as each profile. Operations & Events and Step Up are still **passwordless** |
| H2 | A newly added profile defaults to **Front Desk** and appears in task dropdowns |
| H3 | That new profile **cannot** reach Elizabeth-only pages or Step Up receipts |
| H4 | Daily Log, to-dos, notes, receipts — create and edit one of each, then relaunch |
| H5 | Email, Messages and Voicemail hubs still load |
| H6 | Undo and redo in a spreadsheet |
| H7 | Colour key, merged cells, checkboxes, bold, column widths — all survive a relaunch |
| H8 | Save All while **offline**, then reconnect | It reports honestly in both states |

---

## What I have not verified

Stated plainly, because the passing test suite is not evidence of any of it:

- **Nothing in this document has been run on real hardware.** Every claim behind
  it comes from executing sliced functions in a sandbox.
- **Notarization.** The DMG is signed but not notarized, so Gatekeeper will warn
  on both Macs, and the in-app updater cannot see this build at all — the public
  release is still v1.1.60 with no assets. Updating the studio today means
  carrying the DMG to each Mac by hand.
- **The deployed Firestore rules.** I have only ever seen `firestore.rules` in
  the repo, never what is actually live.
- **Real Google API behaviour under rate limiting**, and sheets much larger than
  the test fixtures.
- **Recovery from a genuinely corrupt local vault** — the quarantine export path
  exists but has never been exercised for real.

### Known and deliberate

- Clearing a whole column of repeated values on a duty-register-shaped sheet can
  still hold the tab. Unchanged from 1.3.5, and the recovery buttons now work.
- Very sparse sheets with scattered single entries can miss a real row insert.
  It fails **loudly** — you get a conflict, not a silent misplacement.
- A project deleted on one Mac can still be resurrected in one narrow case: the
  deletion has reached storage, the other Mac has not noticed, and no save has
  succeeded in between. Much narrower than before; a proper fix is still to do.
- Elizabeth must sign in once on any new Mac before staff can use it. That is by
  design — staff are passwordless, so there is no secret to derive a key from.
  She does not need to be physically present; a remote session she drives herself
  is equivalent, as long as nobody else types her passcode.
