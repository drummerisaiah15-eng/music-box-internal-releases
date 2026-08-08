// electron-builder afterPack hook — narrow App Transport Security.
//
// Electron's own Info.plist ships NSAppTransportSecurity with
// NSAllowsArbitraryLoads = true. Setting `mac.extendInfo` in package.json does
// NOT override it: electron-builder deep-merges extendInfo into the existing
// block and the existing `true` wins. That was tried, appeared to work, and did
// nothing at all — the built app still allowed arbitrary loads while the config
// claimed otherwise. Config that lies is worse than no config, so it was
// removed and replaced with this: rewrite the plist, then read it back and
// fail the build if it did not take.
//
// Safe to narrow because every host the app actually contacts is HTTPS —
// Firestore, Identity Toolkit, App Check, Google Sheets and OAuth, Microsoft
// Graph, RingCentral, Anthropic, themusicboxinc.com. The only plain-HTTP URL in
// the source is a display link the system browser opens, which ATS does not
// govern. The loopback listener that receives the Google OAuth callback is
// covered by NSAllowsLocalNetworking plus the explicit exception domains below.
//
// This runs before code signing, so the change is inside the signature. The
// build verifies that too.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// electron-builder allows exactly ONE afterPack hook, and one was already
// wired: the Electron fuse hardening (RunAsNode off, asar integrity on, and the
// rest). Pointing afterPack here without calling it would silently drop every
// one of those protections — which is exactly what happened on the first
// attempt, and what the release-config test caught. Composition, not
// replacement.
const hardenElectronFuses = require('../tests/harden-electron-fuses.js').default;

const PLUTIL = '/usr/bin/plutil';

const POLICY = {
  NSAllowsArbitraryLoads: false,
  // The Google OAuth callback is served on a random loopback port by main.
  NSAllowsLocalNetworking: true,
  NSExceptionDomains: {
    localhost: {
      NSExceptionAllowsInsecureHTTPLoads: true,
      NSIncludesSubdomains: false,
    },
    '127.0.0.1': {
      NSExceptionAllowsInsecureHTTPLoads: true,
      NSIncludesSubdomains: false,
    },
  },
};

exports.default = async function afterPack(context) {
  // Fuses first, and unconditionally — it throws on a non-darwin target on
  // purpose, and that refusal must not be swallowed by an early return here.
  await hardenElectronFuses(context);

  const appName = context.packager.appInfo.productFilename;
  const plist = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) {
    throw new Error(`afterPack: Info.plist not found at ${plist}`);
  }

  execFileSync(PLUTIL, [
    '-replace', 'NSAppTransportSecurity', '-json', JSON.stringify(POLICY), plist,
  ]);

  // Read it back. The whole reason this file exists is that the previous
  // attempt looked correct in the config and was ignored in the artifact.
  const arbitrary = execFileSync(PLUTIL, [
    '-extract', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', 'raw', '-o', '-', plist,
  ]).toString().trim();
  if (arbitrary !== 'false') {
    throw new Error(
      `afterPack: NSAllowsArbitraryLoads is "${arbitrary}" in the built app, expected "false". ` +
      `App Transport Security was not narrowed; refusing to produce this build.`);
  }

  const loopback = execFileSync(PLUTIL, [
    '-extract', 'NSAppTransportSecurity.NSAllowsLocalNetworking', 'raw', '-o', '-', plist,
  ]).toString().trim();
  if (loopback !== 'true') {
    throw new Error(
      `afterPack: NSAllowsLocalNetworking is "${loopback}", expected "true". ` +
      `The Google OAuth loopback callback would be blocked.`);
  }

  console.log('  • App Transport Security narrowed  arbitrary loads=false, loopback=true');
};
