# Build and Release Instructions

The application uses `electron-updater` (Squirrel.Mac), not Sparkle. Release
publication is fail-closed: tests, updater artifact pairing, code signing,
notarization, stapling, and Gatekeeper assessment must all pass before upload.
Electron Builder always runs with publication disabled; a separate publisher
uploads only the files that passed the post-build verification gate.

## First-Time Setup

### 1. Create a GitHub repo for releases
Create a **public** GitHub repo named `music-box-internal-releases` (public so the app can download updates without needing a token). No code goes here — only release assets.

Owner is set to `drummerisaiah15-eng` — no changes needed.

### 2. Store notarization credentials in Keychain

Create a named `notarytool` profile. Omitting `--password` is intentional:
`notarytool` prompts securely instead of putting the app-specific password in
shell history or process arguments.

```bash
xcrun notarytool store-credentials "music-box-internal-notary" \
  --apple-id "your@icloud.com" \
  --team-id "MULN9RP9V5"
```

### 3. Set non-password environment variables

Add these to `~/.zshrc` or `~/.zprofile`:

```bash
export APPLE_TEAM_ID="MULN9RP9V5"
export APPLE_KEYCHAIN_PROFILE="music-box-internal-notary"
export GH_TOKEN="github-token-with-release-repo-access"
```

The release script rejects `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`.
Alternatively, it accepts the complete `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` credential set instead of a
Keychain profile.

---

## Build and publish a new version

Do not edit the version by hand and do not run `electron-builder --publish`
directly. Use the guarded release command:

```bash
cd "/Users/isaiahchaves/Claude/Projects/CueLab Desktop App/electron"
./release.sh          # patch bump
# ./release.sh minor
# ./release.sh major
# ./release.sh 1.2.0
```

This will:

- Create a detached worktree at the recorded source commit, copy in only the
  controlled version-file changes, and run `npm ci` from `package-lock.json`.
  Ignored or locally modified `node_modules` directories cannot enter a release.
- Remove `GH_TOKEN` and Apple credential variables from dependency install,
  tests, and browser-vendor preparation. The build also runs without
  `GH_TOKEN`; only the version checks and publisher receive it, and those
  GitHub-only processes do not receive Apple notarization credentials.
- Run every `tests/*.test.js` test and prepare pinned, local Firebase and
  SheetJS browser bundles inside that clean worktree.
- Record a pre-build SHA-256 manifest for the first-party JavaScript, preload,
  PDF worker, HTML, and generated browser-vendor files. Both the updater ZIP and
  mounted DMG must contain the exact recorded bytes, and the manifest is bound
  into release provenance.
- Update both `package.json` and `package-lock.json`.
- Restore both version files automatically if the build, verification gate, or
  publication command fails.
- Build deterministic `Music-Box-Internal-<version>-arm64` artifacts.
- Flip and verify the production Electron fuses before signing: Run As Node,
  Node options, and CLI inspection are disabled; cookie encryption, embedded
  ASAR integrity, and ASAR-only app loading are enabled.
- Sign and notarize the app bundle.
- Sign, separately notarize, and staple the DMG container.
- Verify the app and DMG with `codesign`, `spctl`, and `stapler`.
- Mount the final DMG read-only, verify the exact app inside it, and always
  detach it. The mounted app and updater ZIP are both checked for bundle ID,
  version, arm64 architecture, Apple team, hardened runtime, helper-app
  entitlement policy, Electron fuses, PDF runtime, first-party content hashes,
  and the exact allowlisted `app-update.yml` schema. Extra updater settings such
  as a host, token, private mode, alternate channel, or HTTP protocol are
  rejected.
- Verify every `latest-mac.yml` URL, size, SHA-512 value, and blockmap.
- Require the configured GitHub update repository to be public and compare the
  candidate against every paginated stable release tag, then repeat that check
  immediately before making the draft public.
- Create an unpublished GitHub draft, upload only the verified files, confirm
  every remote asset name, size, state, and available SHA-256 digest, then make
  the release public. After publication, make anonymous requests for the live
  latest release, `latest-mac.yml`, updater ZIP, and named ZIP blockmap and
  compare them with the locally verified files. Then enumerate stable releases
  again and require this candidate to remain the strict maximum semantic
  version before recording publication success.

If a release fails, the local version files are restored automatically. Inspect
the failure before retrying. Do not reuse a version if a GitHub release was
partially created before a publication error. An upload failure intentionally
leaves an unpublished draft for inspection instead of exposing an incomplete
update. If GitHub makes a release public but anonymous validation cannot prove
the live files, the local publication state is `unknown`, the version files and
release evidence are retained, and the release requires manual inspection.

---

## First install on a new computer
Download the zip from the GitHub releases page, unzip, drag `Music Box Internal.app` to `/Applications`, and open it. Auto-updates handle everything after that.

---

## Development

Run from source:

```bash
npm start
```

Create an unpacked local app without signing, notarization, or publication:

```bash
npm run build
```

There is intentionally no standalone release-build command. A release build
depends on the clean-worktree setup, provenance environment, isolated output
directory, secret scoping, and publication-state recovery owned by
`release.sh`. The internal build script refuses ordinary direct use.

Re-check existing artifacts:

```bash
npm run release:verify
```

---

## Notes
- The Developer ID certificate team is `MULN9RP9V5`.
- Notarization requires internet and either the named Keychain profile or a
  complete App Store Connect API key credential set.
- `pdf-worker.js` is packaged inside `app.asar`; the arm64 native canvas dependency used by PDF
  parsing is explicitly unpacked for Electron. Spreadsheet file import and its former worker have
  been removed.
- Auto-update payloads use the ZIP. The ZIP and `<zip>.blockmap` names are
  intentionally identical apart from the `.blockmap` suffix.
- GitHub does not offer an atomic transaction that combines “no higher stable
  version exists” with publishing a draft. The publisher checks immediately
  before publishing, requires this candidate to be the anonymous live latest
  release, and checks the strict maximum stable version again afterward. A
  conflicting higher release visible during those checks leaves local state
  `unknown` and requires manual inspection. Another authorized release host can
  still publish after the final check, so release credentials must remain
  limited to one coordinated release process.
- Pinned browser assets are generated in ignored `vendor/` and copied to
  `Contents/Resources/vendor/`; the packaged app does not need Firebase or
  SheetJS CDNs.
- `autoInstallOnAppQuit` is disabled. Choosing “Later” never installs the
  downloaded update during an ordinary quit; installation happens only after
  the explicit restart-and-install action.
