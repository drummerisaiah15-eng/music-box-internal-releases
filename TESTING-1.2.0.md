# Music Box Internal 1.2.0 — what to test

Run against the throwaway Firebase project. Not production data.

Report failures by number — that's enough for me to find them.

---

## A. Start here — the activity panel

This is the one I've now fixed three times. The last fix (1.1.99) is the one I
believe is the actual cause: automatic Google checks were deleting the credit
for every cell they touched, which is exactly the cells you'd just typed.

1. Type in a cell. Your name appears in the panel.
2. **Wait five minutes without touching anything.** The name is still there.
   This is the test that failed before — the sync timer was erasing it.
3. Switch to another profile. Open the same project and the same tab. The name
   is still there and still says who made the edit.
4. Three profiles each edit a different cell on one sheet. All three chips
   appear, and clicking between them doesn't make any of them vanish.
5. Type something into an empty cell, then delete it. **No credit is recorded**
   — that cell should leave no trace in the panel.
6. Colour an empty cell with no text in it. That *does* count as a change.
7. Open a project, leave it open five minutes, come back. The panel still shows
   what it showed.

## B. Google sync

Your project card has been showing **"Last check failed"** every couple of
minutes. That's a real failure I haven't diagnosed.

8. Hover the "Last check failed" badge. **Tell me the tooltip text.** That's
   the one piece of information I still need.
9. Open a linked project — it should check Google on open, without you pressing
   Sync now.
10. Rename a tab in Google, then open the project. It keeps syncing and adopts
    the new name.
11. Change only a cell's **fill colour** in Google, leaving the text alone. The
    colour comes across.
12. Tick a **checkbox** in Google. It comes across.
13. **Widen a column** in Google. The width follows on the next sync.
14. **Add a new tab** in Google. The card says "1 new tab in Google".
15. Edit the same cell in both Google and the app. You keep yours and a
    conflict is recorded — nothing is silently overwritten.

## C. Colour key and the picker

16. Turn the colour key on. Switch tabs — it's still open on every one.
17. Quit and reopen. Still open.
18. Another profile opens the project. Still open for them.
19. Press **Add Entry**. The key stays open and the new row appears.
20. Click a key swatch — the picker opens *beside the grid*, not in the corner
    of the screen.
21. Rename a key entry, change its colour, delete an entry.
22. Custom fill: drag in the square, drag the hue slider, type a hex, press
    Enter, press Escape, click outside.
23. Reopen the picker on a coloured cell — it starts on that cell's colour.
24. **Eyedropper (◯)**: click it, then pick a colour from anywhere on screen,
    including another window. It lands in the picker.

## D. Grid

25. Zoom in and out with the trackpad. It should glide, not judder. (1.1.94
    broke this; 1.1.95 fixed it.)
26. At 62–75%, the lines between cells are clearly visible against the black,
    grey and green fills — compare against the same sheet in Google.
27. Zoom anchors on the pointer, not the top-left corner.
28. Merge cells, unmerge, add and delete rows and columns.
29. A long note clips to two lines and shows in full in the CELL bar above.

## E. Two Macs at once

The semantic-merge work. Each of these used to lose one side.

30. Both Macs add a **different to-do** at the same time — both survive.
31. One ticks a to-do, the other renames the same one — both changes stick.
32. One deletes a to-do while the other edits it — the edit wins, item stays.
33. Repeat 30–32 for **assigned tasks**, **policies**, and **Step Up receipts**.
34. Both Macs edit **different cells** in the same project — both survive.
35. Both Macs edit the **same cell** differently — both copies are kept and a
    conflict is offered.
36. Quit one Mac mid-edit, reopen — nothing lost.
37. Edit the same **Daily Log** entry on both Macs — both bodies kept, and
    resolving one makes it stay resolved.

## F. Profiles

38. Add a profile from the **signed-out login screen**. It warns it isn't
    shared yet.
39. Sign in as Elizabeth → it publishes, and Settings → Manage Users shows no
    pending banner.
40. The new profile appears on the other Mac.
41. Carrie / Operations & Events and Step Up are **still passwordless**.
42. New profiles default to Front Desk with no Step Up, no Staff Workload, no
    owner Settings.
43. New profiles appear in every task-assignee dropdown and in Staff Workload.

## G. Everything else

44. Morning brief: no Waitlist section; every other section still fills in.
45. Save All completes rather than hanging on "Saving…".
46. Quit with unsaved changes — the prompt behaves and nothing is lost.
47. Delete a project — it stays deleted after switching tabs and after a
    restart.
48. Import a Google spreadsheet with several tabs — all tabs, colours, merges,
    checkboxes and column widths come across.
49. The import is **not** listed as edits in the activity panel.
50. Staff Workload excludes Owner and Operations Manager, and lists only
    current profiles.

---

## Known, not fixed

- **"Last check failed"** on the Google card — real, undiagnosed. See #8.
- App Transport Security is still wide open. The config that was meant to
  narrow it had no effect on the built app, so it was removed rather than left
  claiming something untrue.
- Row and column insert/delete in Google has no coordinate transform — inserting
  a row in Google can misalign the mirrored copy. Needs Google's revision
  history to do properly.
- This build is arm64 only, unsigned by Apple's notary service, and has not
  gone through `./release.sh`. Fine for testing, not a release artifact.
