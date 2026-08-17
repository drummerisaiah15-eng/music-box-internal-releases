#!/usr/bin/env node
'use strict';

// MB1188-091: will this artifact open on a Mac that is not this one?
//
// A build signed with the Developer ID certificate but never sent to Apple for
// notarization runs perfectly on the machine that built it, because that copy
// was never quarantined. Hand the same DMG to another Mac — download, AirDrop,
// shared drive, USB — and macOS attaches `com.apple.quarantine`, finds no
// notarization ticket, and refuses to launch it. What the person sees is
//
//     "Music Box Internal.app" is damaged and can't be opened.
//     You should move it to the Trash.
//
// which reads like a corrupt download, so the natural response is to download
// it again, and again. The only way in is System Settings -> Privacy &
// Security -> Open Anyway, once per Mac, for every future update.
//
// Nothing in the app can detect this and nothing in a normal build fails, so
// the only defense is checking the artifact before it is handed to anybody.
// `./release.sh` produces notarized, stapled artifacts; a local build made with
// `-c.mac.notarize=false` never does, and is for testing on the build Mac only.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SPCTL = '/usr/sbin/spctl';
const XCRUN = '/usr/bin/xcrun';

// Split out from the process work so the verdict can be tested against real
// tool output rather than mocked at the process boundary.
function assess(spctlOutput, staplerOutput) {
  const spctl = String(spctlOutput || '');
  const stapled = /The validate action worked/i.test(String(staplerOutput || ''));

  if (/notarization indicates this code has been revoked/i.test(spctl)) {
    return {
      ok: false,
      verdict: 'revoked',
      reason: 'Apple has revoked this build. It will not open on any Mac, including this one.',
      advice: 'Do not distribute it. Cut a fresh release and find out why the ticket was revoked.',
    };
  }
  if (/source=Unnotarized Developer ID/i.test(spctl)) {
    return {
      ok: false,
      verdict: 'unnotarized',
      reason: 'Signed with the Developer ID certificate but never notarized by Apple.',
      advice:
        'This opens on the Mac that built it and nowhere else. Any other Mac will call it ' +
        'damaged and refuse to launch it. Build it with ./release.sh, which notarizes and ' +
        'staples, before giving it to anybody.',
    };
  }
  if (/: rejected/i.test(spctl)) {
    return {
      ok: false,
      verdict: 'rejected',
      reason: `Gatekeeper rejected this artifact:\n${spctl.trim()}`,
      advice: 'Do not distribute it.',
    };
  }
  if (!/: accepted/i.test(spctl)) {
    return {
      ok: false,
      verdict: 'unknown',
      reason: `Gatekeeper returned something this check does not recognise:\n${spctl.trim()}`,
      advice: 'Treat it as unsafe to distribute until somebody has read the output above.',
    };
  }
  if (!/source=Notarized Developer ID/i.test(spctl)) {
    return {
      ok: false,
      verdict: 'accepted-not-notarized',
      reason:
        `Gatekeeper accepted it, but not as a notarized Developer ID build:\n${spctl.trim()}`,
      advice:
        'An assessment can be accepted for local reasons that do not travel — this Mac ' +
        'having launched it before, or Gatekeeper being disabled. Do not distribute it.',
    };
  }
  if (!stapled) {
    return {
      ok: false,
      verdict: 'unstapled',
      reason: 'Notarized, but the ticket is not stapled to the artifact.',
      advice:
        'A Mac that is offline, or behind a network that cannot reach Apple, cannot check ' +
        'the ticket and will refuse to open it. Staple it before distributing.',
    };
  }
  return {
    ok: true,
    verdict: 'notarized',
    reason: 'Notarized by Apple and stapled. It will open on a Mac that has never seen it.',
    advice: '',
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) return `${command} could not be run: ${result.error.message}`;
  // spctl writes its assessment to stderr; stapler writes to stdout.
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function main(argv) {
  const target = argv[0];
  if (!target) {
    console.error('Usage: node scripts/verify-gatekeeper.js <path to .dmg or .app>');
    return 2;
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`No such artifact: ${resolved}`);
    return 2;
  }
  // A disk image is assessed as something being installed; an app bundle as
  // something being executed. `-t open` is for documents, and asking it about
  // an app answers "source=Insufficient Context" — a rejection that says
  // nothing about whether the app is notarized.
  const type = resolved.endsWith('.dmg') ? 'install' : 'exec';
  const spctl = run(SPCTL, ['-a', '-vvv', '-t', type, resolved]);
  const stapler = run(XCRUN, ['stapler', 'validate', resolved]);
  const verdict = assess(spctl, stapler);

  console.log(`${path.basename(resolved)}: ${verdict.verdict.toUpperCase()}`);
  console.log(verdict.reason);
  if (verdict.advice) console.log(verdict.advice);
  return verdict.ok ? 0 : 1;
}

module.exports = { assess, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
