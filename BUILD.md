# Build Instructions

## First-Time Setup

### 1. Create a GitHub repo for releases
Create a **public** GitHub repo named `music-box-internal-releases` (public so the app can download updates without needing a token). No code goes here — only release assets.

Owner is set to `drummerisaiah15-eng` — no changes needed.

### 2. Set environment variables (add to ~/.zshrc or ~/.zprofile)
```bash
export APPLE_ID="your@icloud.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # generate at appleid.apple.com → App-Specific Passwords
export GH_TOKEN="ghp_xxxxxxxxxxxx"                          # GitHub token with repo scope (github.com/settings/tokens)
```

---

## Build & publish a new version

### Step 1 — Bump the version in package.json
Change `"version": "1.0.0"` to the new version (e.g. `"1.1.0"`).

### Step 2 — Build, sign, notarize, and publish to GitHub in one command
```bash
cd "/Users/isaiahchaves/Claude/Projects/CueLab Desktop App/electron"
npm run publish
```

This will:
- Package the app
- Sign with your Developer ID Application cert (MULN9RP9V5)
- Notarize with Apple (takes ~1–3 min)
- Staple the notarization ticket
- Upload the zip + `latest-mac.yml` to GitHub Releases automatically

### Step 3 — Done
All installed copies of the app will silently download the update in the background and show a "Restart Now" prompt when ready.

---

## First install on a new computer
Download the zip from the GitHub releases page, unzip, drag `Music Box Internal.app` to `/Applications`, and open it. Auto-updates handle everything after that.

---

## Local dev build (no signing, no publish)
```bash
npm run build
```
Output goes to `dist/`. Use the zip in `dist/` for manual installs.

---

## Notes
- The Developer ID cert (`MULN9RP9V5`) is already in Keychain — no extra setup needed
- Notarization requires internet and an Apple-specific app password (not your main Apple ID password)
- `autoInstallOnAppQuit` is on — updates install automatically the next time the app is quit even if the user clicks "Later"
