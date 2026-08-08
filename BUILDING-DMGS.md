# How to build a test DMG

Written 8 Aug 2026. This is the exact procedure used for every build from
1.1.90 through 1.3.1 — roughly twenty of them. Written down because several
steps look like failures and are not.

Repo root: `/Users/isaiahchaves/Claude/Projects/CueLab Desktop App/electron`
(the `electron` subfolder is the git root — the parent is named
"CueLab Desktop App" for historical reasons).

---

## The one thing to understand first

**Builds must run on the Mac, not in the sandbox.**

The `mcp__workspace__bash` sandbox is Linux. It can read and edit the repo
(mounted at `/sessions/<id>/mnt/electron`) and it can run `node --test`, but it
cannot build: no `codesign`, no `hdiutil`, no macOS. Use it for editing and for
fast test iteration.

Use **desktop-commander** (`mcp__plugin_desktop-commander_desktop-commander__start_process`)
for anything that builds, signs, mounts or verifies. That runs on the real Mac.

Two macOS-only tests fail in the sandbox and pass on the Mac:
`tests/pdf-worker.test.js` (needs the `@napi-rs/canvas` native binding) and
`failed publication restores both version files byte-for-byte` (needs
`codesign`). **Never conclude a test is broken from the sandbox count alone** —
re-run `npm test` on the Mac.

---

## The build command

Do **not** use `npm run build` (that is `--dir`, unsigned, no DMG) and do
**not** use `npm run release` (that publishes — needs Isaiah's authorization and
his Apple credentials).

```bash
cd "/Users/isaiahchaves/Claude/Projects/CueLab Desktop App/electron"

# 1. tests must pass ON THE MAC
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"

# 2. bump BOTH version files — they must not drift
node -e "
const fs=require('fs');
for (const f of ['package.json','package-lock.json']) {
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  d.version='1.3.2';                        // <- set this
  if (d.packages) d.packages[''].version='1.3.2';
  fs.writeFileSync(f, JSON.stringify(d,null,2)+'\n');
}"

# 3. commit (see HANDOFF.md for the commit-message expectations)

# 4. build
rm -f dist/*.dmg dist/*.blockmap
npx electron-builder --mac dmg --arm64 --publish never -c.mac.notarize=false
```

`--publish never` and `-c.mac.notarize=false` are both required. Notarization
needs Apple credentials that must never pass through here.

---

## It takes ~4–5 minutes, which is longer than the tool timeout

`start_process` caps out well before the build finishes. Backgrounding and
polling is the pattern that works:

```bash
cd "…/electron" && nohup npx electron-builder --mac dmg --arm64 \
  --publish never -c.mac.notarize=false > /tmp/build.log 2>&1 &
sleep 165; pgrep -f electron-builder >/dev/null && echo "STILL BUILDING" || echo DONE
```

Then poll in a separate call until it finishes:

```bash
cd "…/electron"; while pgrep -f electron-builder >/dev/null; do sleep 5; done
ls -la dist/*.dmg
```

If a poll call itself times out, just issue another one — the build keeps
running in the background regardless.

---

## Two things that look like failures and are not

**1. The release gate "fails" the build after producing the DMG.**

```
⨯ Release verification failed: distribution builds must set MUSIC_BOX_RELEASE_VERIFY=1
```

`build.afterAllArtifactBuild` is `tests/release-artifact-gate.js`. It refuses to
certify any distribution build that did not come through `./release.sh`. It runs
*after* the DMG is written, so the file exists and is valid — it simply has not
been through the release workflow. For test builds this is correct and expected.
Check `ls dist/*.dmg` rather than the exit code.

**2. `spctl` says "rejected".**

```
rejected
source=Unnotarized Developer ID
```

That is what an unnotarized build is supposed to say. It is **not** an invalid
signature. Two consecutive pentests called this a P0 blocker and both were
wrong. The signature checks that matter are `codesign --verify`, below.

---

## Verify the artifact, never the source

This is the rule that matters most. `mac.extendInfo` was silently ignored by
electron-builder and a false claim about App Transport Security would have
shipped if the plist inside the DMG had not been read.

```bash
cd "…/electron"
M=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$M" dist/Music-Box-Internal-1.3.2-arm64.dmg
APP="$M/Music Box Internal.app"

codesign --verify --deep --strict "$APP" && echo "app: valid on disk"
codesign --verify dist/Music-Box-Internal-1.3.2-arm64.dmg && echo "dmg: valid on disk"

# ATS actually narrowed? (must print false, then true)
/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$APP/Contents/Info.plist"

# fuses still hardened?
npx @electron/fuses read --app "$APP" | grep -iE "RunAsNode|OnlyLoadAppFromAsar|EnableEmbeddedAsarIntegrity"

# your actual change, in the SHIPPED renderer
grep -c "someStringFromYourFix" "$APP/Contents/Resources/index.html"

hdiutil detach "$M"
shasum -a 256 dist/Music-Box-Internal-1.3.2-arm64.dmg
```

Expected: `valid on disk` twice, ATS `false` then `true`, RunAsNode **Disabled**,
OnlyLoadAppFromAsar **Enabled**, asar integrity **Enabled**.

For renderer changes, `index.html` sits unpacked at
`Contents/Resources/index.html` — grep it directly. `main.js`, `preload.js` and
`pdf-worker.js` are inside `app.asar` (`build.files` packs only those three);
extract with `npx asar extract "$APP/Contents/Resources/app.asar" /tmp/x`.

---

## The afterPack hook — do not break it

`build.afterPack` is `./scripts/after-pack.js`, and it does **two** things:

1. `hardenElectronFuses(context)` — RunAsNode off, asar integrity on, etc.
2. Rewrites `NSAppTransportSecurity` in the packed `Info.plist`, then reads it
   back and **fails the build** if it did not take.

electron-builder allows exactly one `afterPack`. An earlier attempt pointed it
at the ATS script alone and silently dropped every fuse protection. The release
config test now asserts the fuses are *invoked*, not just that the path is
unchanged. If you add another packaging step, compose it into this file.

It runs before code signing, so plist edits land inside the signature. The
`codesign --verify` above is what proves that.

---

## Presenting the build

Use `mcp__cowork__present_files` with the DMG path so Isaiah gets a clickable
card. Give the sha256 and say what was verified inside the bundle — not what the
source says.

---

## Never do these without explicit authorization

- `npm run release` / `./release.sh` — publishes to GitHub
- notarize or staple — needs his Apple credentials, which must never come here
- `git tag`, or any change to the public release
- touch production Firebase or iCloud (`musicbox-testing-01` is the throwaway)

Pushing `main` was authorized on 8 Aug and that stands. There are currently
**6 unpushed commits**.
