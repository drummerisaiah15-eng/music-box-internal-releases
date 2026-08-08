# Music Box Internal 1.3.4 — what to test

Supersedes `TESTING-1.2.5.md` for the new work. Section 0 of that file (does it
still connect?) is still worth a pass; everything below is what changed since.

Install **1.3.4 on BOTH Macs** first. `/Applications` currently has 1.3.2, which
predates all of this. Use the throwaway Firebase project. Report failures by
number.

**The theme this time: three of the four fixes in the previous build were
defective, and a review found them — not my testing.** So the tests below are
written to catch a fix that *looks* right. Where a test says "quit and reopen",
that is the test; the on-screen result is not.

Two of these are things I have never seen work outside a test harness: **§B
(profiles)** and **§C (Google structure)**. They deserve the most suspicion.

---

## A. Google import — the column-width refusal (MB1188-014)

The import used to be refused outright by a validator that disagreed with its
own producers about how narrow a column may be.

| | Check | Expect |
|---|---|---|
| A1 | Re-import the sheet that failed with **"invalid column widths"** | It imports |
| A2 | Look at the imported tab | Narrow columns are narrow, not collapsed or uniform |
| A3 | Quit and reopen | The project is still there with its widths |
| A4 | Import a sheet with a very wide column (>1000px in Google) | Imports; that column is clamped, nothing is refused |
| A5 | Let a linked project auto-sync after someone narrows a column in Google | No error, no quarantine, and the project still saves afterwards |

**A5 is the one that matters most.** The second half of this bug was the sync
path writing an out-of-range width into an already-imported project, after which
*every save of that project failed*. If saving breaks after a Google sync, this
is why.

## B. Profiles across Macs (MB1188-028)

Profiles are created signed-out, so publishing is always deferred. It was being
deferred to a moment when Firebase had not started yet, so it never happened.

| | Check | Expect |
|---|---|---|
| B1 | On **Elizabeth's Mac**, login screen → add a profile | "added on this Mac … not yet shared" |
| B2 | Sign in as Elizabeth on that Mac | Toast: profiles added while signed out are now shared |
| B3 | Firestore → `staff_directory` | The document's `revision` **goes up**. This is the whole fix |
| B4 | Mac B (running) | The new profile appears in its login list within seconds |
| B5 | Quit and reopen Mac B | Still there |
| B6 | Elizabeth removes a profile on her Mac | It disappears on Mac B, and stays gone after a relaunch |
| B7 | Settings → Manage Users on Elizabeth's Mac | **No** "Share now" banner once B2 has happened |

**Known and deliberate:** a profile added on the Mac Elizabeth does *not* sign
into stays local until she signs in there. I widened publishing to fix that, a
review showed it let a stale Mac delete profiles on the other, and I reverted it.
The proper fix is still to do.

| | Check | Expect |
|---|---|---|
| B8 | Add a profile at the login screen on **Mac B**, sign in as someone who is not Elizabeth | Stays local. Manage Users is owner-only, so you will not see a banner |
| B9 | Now sign in as Elizabeth **on Mac B** | It publishes, and reaches Mac A |

If B9 fails, the deferral is still broken and B1–B7 passing was luck.

## C. Google rows and columns moving (MB1188-016)

Inserting a row in Google shifts everything below it. Rows you had edited in the
app used to be corrupted: the edit landed on the wrong row and destroyed what
moved into its place. **The app no longer tries to realign — it refuses.**

| | Check | Expect |
|---|---|---|
| C1 | Edit a cell in the app on a linked tab. Don't push. In Google, insert a row **above** it. Let it sync | The tab is **HELD**: a warning naming the tab and saying rows or columns moved |
| C2 | Open the tab | **Unchanged.** Your edit is where you left it; nothing corrupted |
| C3 | Firestore → the project doc | The checkpoint has **not** advanced |
| C4 | Same again but delete a row in Google instead | Also held |
| C5 | **No local edits.** Insert a row in Google, sync | **Not** held — the tab updates and lines up correctly |
| C6 | Edit a cell in the app; in Google change a *different* cell in place (no insert) | **Not** held — normal merge, and a genuine clash raises a conflict as before |

**C5 and C6 are the important ones.** Holding when it should not is the failure
mode I am most worried about — a tab that is held every sync never converges,
because the checkpoint deliberately does not advance. If you see a hold on an
ordinary edit, tell me and I will loosen the detector.

| | Check | Expect |
|---|---|---|
| C7 | On a **large** tab (hundreds of rows), trigger a sync | No visible freeze or beachball while it checks |

C7 is unmeasured — I have not benchmarked the new check on a real schedule.

## D. Projects across Macs (MB1188-015) — re-confirm

You confirmed this on 1.3.2. Worth one pass on a fresh build.

| | Check | Expect |
|---|---|---|
| D1 | Mac A creates a project | Appears on Mac B within seconds, **without relaunching B** |
| D2 | Mac A deletes it | Gone on B, stays gone after relaunch |
| D3 | Create on B, edit it on A | Edits flow both ways |

## E. Regression — things I changed underneath

| | Check | Expect |
|---|---|---|
| E1 | Ordinary spreadsheet editing, several cells, quit, reopen | Everything durable |
| E2 | Two Macs editing **different** projects at once | Both land, no conflict |
| E3 | Two Macs editing the **same cell** | Conflict raised, both versions offered, yours kept |
| E4 | Colour a cell, merge some cells, resize a column, quit, reopen | All intact |
| E5 | Sign in as a non-owner profile | Manage Users hidden; no way to publish or remove |
| E6 | Operations & Events (Carrie) and Step Up | Still passwordless |
| E7 | Log entries, to-dos, staff notes across both Macs | Still sync |

---

## What I have NOT verified

Stated plainly so you know where to push:

- Everything in §B and §C has only ever run in a test harness.
- §C7 performance is unmeasured.
- A held tab (§C1) has no recovery action — re-importing the tab is the only way
  out. If you hit that, it is a gap, not you doing it wrong.
- The public release is still v1.1.60 with no assets, so the **in-app updater
  cannot see 1.3.4**. Install it by hand on both Macs.
