'use strict';

const {
  FuseVersion,
  FuseV1Options,
} = require('@electron/fuses');

const FUSE_CONFIG = Object.freeze({
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});

async function hardenElectronFuses(context) {
  if (context?.electronPlatformName !== 'darwin') {
    throw new Error('Music Box fuse hardening only supports the macOS release target.');
  }
  if (typeof context?.packager?.addElectronFuses !== 'function') {
    throw new Error('Electron Builder did not expose its fuse writer.');
  }

  await context.packager.addElectronFuses(context, FUSE_CONFIG);
}

exports.default = hardenElectronFuses;
exports.FUSE_CONFIG = FUSE_CONFIG;
