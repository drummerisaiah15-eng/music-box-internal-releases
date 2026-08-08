# Music Box Internal 1.2.5 — what to test

Supersedes `TESTING-1.2.0.md` (that one is stale — safe to delete).

Use the throwaway Firebase project. Report failures by number.

**The theme this time: don't trust the screen.** Every P0 in the last pentest
was the app *saying* something worked when nothing had been written. So for
anything that changes data, the real test is **quit, reopen, and look again**.

---

## 0. Does it still connect? — do this first

I narrowed App Transport Security in this build. Everything the app talks to is
HTTPS so it should be invisible, but if it isn't, nothing below matters.

1. Sign in as Elizabeth. Top bar reaches **Synced** (not "Sync error").
2. Email Hub loads mail.
3. Voicemail / Messages Hub load.
4. Settings → Google Sheets still shows connected; press **Sync now** on a
   linked project and it completes.
5. Musicbox Agent answers a question (that's the AI provider).
6. Disconnect and reconnect Google — the browser hand-off and the loopback
   callback still work. **This is the one most at risk from the ATS change.**

If any of 1–6 fail, stop and tell me — I'll revert the ATS change immediately.

## A. The save-path P0s — highest priority

These are the bugs that reported success while writing nothing.

7. **Import a Google spreadsheet. Quit. Reopen.** The project is still there.
   (It used to vanish — the import wrote nothing at all.)
8. Import one, then check Firestore: the project document exists.
9. **Delete a sheet. Quit. Reopen.** It stays deleted.
10. **Delete a project. Quit. Reopen.** It stays deleted and does not come back.
11. Delete a project on one Mac; the other Mac does not resurrect it.
12. **New Sheet → type immediately into A1 → quit → reopen.** The text is in the
    *new* sheet, the new tab is still selected, and the old sheet is untouched.
    (It used to write into Sheet 1 while showing you Sheet 2.)
13. Press **Save All** right after an import or delete — it completes and the
    change is durable after restart.
14. Make a change, then quit with the "unsaved changes" prompt — nothing is lost.
15. Turn off Wi-Fi, make several spreadsheet edits, quit, reopen, turn Wi-Fi
    back on. Everything is still there and syncs.

## B. Attribution and the activity panel

16. Type in a cell — your name appears in the panel **immediately**, without
    clicking anything else.
17. Wait five minutes without touching anything. The name is still there.
18. Switch profile, open the same project and tab — the name is still there and
    still credits the right person.
19. Let an automatic Google sync run over a cell **Google** changed. That cell is
    **not** credited to whoever is signed in.
20. A cell *you* changed during the same period still shows your name.
21. Type something into an empty cell then delete it — no credit recorded.
22. Colour an empty cell — that *does* count.

## C. Two Macs at once — the acceptance gate

Nothing else substitutes for this.

23. Both Macs add a **different to-do** — both survive.
24. One ticks a to-do, the other renames the same one — both stick.
25. One deletes a to-do while the other edits it — the edit wins, item stays.
26. Repeat 23–25 for **assigned tasks**, **policies**, **Step Up receipts**.
27. Both post a **team note**; one deletes theirs — the other's survives.
28. Both flag a **different email** — both flags survive.
29. Both edit **different cells** in one project — both survive.
30. Both edit the **same cell** differently — both copies kept, conflict offered,
    and resolving it sticks after restart on both.
31. Edit the same **Daily Log** entry on both — both bodies kept.
32. Take one Mac offline, edit on both, reconnect — nothing is lost either way.
33. Quit one Mac mid-edit, reopen — nothing lost.

## D. Google mirror

34. Change a cell's **fill only** in Google (same text) — the colour arrives.
35. Tick a **checkbox** in Google — it arrives.
36. **Widen a column** in Google — the width follows.
37. **Rename a tab** in Google — the link survives and adopts the new name.
38. **Add a tab** in Google — the card says "1 new tab in Google".
39. Edit the same cell in Google and the app. The toast says your copy was kept
    — now open the conflict and confirm **Google's value is actually there**.
    Restart and confirm it's still recoverable. (It used to be discarded.)
40. **The write-loop check:** open a linked project, leave it ten minutes, then
    look at the project document's `revision` in Firestore. It should barely
    move. If it climbs by dozens, tell me.
41. Any **"Last check failed"** badge — hover it and send me the tooltip.

## E. Spreadsheet interface

42. Colour key: on, switch tabs, quit, reopen, other profile — still open.
43. **Add Entry** — the key stays open and the row appears.
44. Click a key swatch — picker opens beside the grid; recolour works.
45. Custom fill: square, hue slider, hex + Enter, Escape, click-outside.
46. **Eyedropper (◯)** — pick a colour from another window.
47. Trackpad zoom glides, doesn't judder, and anchors on the pointer.
48. At 62–75% the gridlines are clearly visible against black, grey and green.
49. Merge / unmerge, add and delete rows and columns.

## F. Profiles

50. Add a profile from the **signed-out** login screen — it warns it isn't shared.
51. Sign in as Elizabeth — it publishes; no pending banner remains.
52. It appears on the other Mac.
53. Carrie / Operations & Events and Step Up are **still passwordless**.
54. New profiles default to Front Desk: no Step Up, no Staff Workload, no owner
    Settings, and `navigate('stepup')` stays on Dashboard.
55. New profiles appear in every assignee dropdown and in Staff Workload.

## G. Everything else

56. Morning brief: no Waitlist section; every other section fills.
57. Daily Log create / edit / delete; deleted stays deleted after restart.
58. Step Up receipt create, autosave, restart.
59. Staff Workload excludes Owner and Operations Manager; current profiles only.
60. Import a multi-tab sheet: colours, merges, checkboxes, widths all arrive —
    and the import is **not** listed as edits in the activity panel.

---

## Known, not fixed

- **Release artifacts (P0-05).** `dist` has only the DMG. No ZIP, blockmap,
  `latest-mac.yml` or `release-provenance.json`, so `npm run release:verify`
  fails and the in-app updater cannot see this build. The public release is
  still v1.1.60 with zero assets. Only the guarded `./release.sh` produces
  these, and it publishes — so it needs your go-ahead and your Apple
  credentials for notarization.
- **Not notarized.** Gatekeeper will warn on a clean Mac. Expected.
- **Google row/column insert/delete** has no coordinate transform — inserting a
  row in Google can misalign the mirrored copy.
- **arm64 only.** No Intel build.
