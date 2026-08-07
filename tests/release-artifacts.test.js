'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  FuseVersion,
  FuseV1Options,
} = require('@electron/fuses');
const { blake2b } = require('@noble/hashes/blake2.js');
const yaml = require('js-yaml');
const test = require('node:test');
const { before, after } = require('node:test');

const packageMetadata = require('../package.json');
const {
  default: hardenElectronFuses,
  FUSE_CONFIG,
} = require('./harden-electron-fuses');
const {
  createSourceContentManifest,
  default: releaseArtifactGate,
  expectedBaseName,
  verifyBuildArtifacts,
  verifyDmgContents,
  verifyElectronFuses,
  verifyFeedArtifacts,
  verifyMacDistribution,
  verifyNestedHelperPolicies,
  verifyPackagedFirstPartyContent,
  verifyPackagedPdfRuntime,
  verifyPackagedUpdaterConfig,
  verifySourceContentManifest,
} = require('./release-artifact-gate');
const {
  assertVersionIsNewerThanGitHub,
  expectedReleaseAssets,
  publishAssetsToDraft,
  snapshotReleaseAssets,
} = require('./publish-verified-release');

// In release mode release.sh exports MUSIC_BOX_PUBLICATION_STATE_FILE pointing
// to its own staging directory. That causes the publishAssetsToDraft security
// check (which asserts the state file is inside outDir) to fire before tests
// can reach their intended assertion. Clear it for the duration of this file.
let _savedPublicationStateFile;
before(() => {
  _savedPublicationStateFile = process.env.MUSIC_BOX_PUBLICATION_STATE_FILE;
  delete process.env.MUSIC_BOX_PUBLICATION_STATE_FILE;
});
after(() => {
  if (_savedPublicationStateFile !== undefined) {
    process.env.MUSIC_BOX_PUBLICATION_STATE_FILE = _savedPublicationStateFile;
  }
});

const SOURCE_COMMIT = 'a'.repeat(40);
const SOURCE_TREE = 'b'.repeat(40);

function digest(contents, algorithm, encoding) {
  return crypto.createHash(algorithm).update(contents).digest(encoding);
}

function sha512(contents) {
  return crypto.createHash('sha512').update(contents).digest('base64');
}

function writeBlockmap(artifactPath) {
  const contents = fs.readFileSync(artifactPath);
  const sizes = [];
  const checksums = [];
  for (let offset = 0; offset < contents.length; offset += 32768) {
    const chunk = contents.subarray(offset, Math.min(offset + 32768, contents.length));
    sizes.push(chunk.length);
    checksums.push(Buffer.from(blake2b(chunk, { dkLen: 18 })).toString('base64'));
  }
  const blockmap = {
    version: '2',
    files: [{ name: 'file', offset: 0, sizes, checksums }],
  };
  fs.writeFileSync(
    `${artifactPath}.blockmap`,
    zlib.gzipSync(Buffer.from(JSON.stringify(blockmap))),
  );
}

function writeFixtureProvenance(outDir, artifactNames) {
  const assets = {};
  for (const name of artifactNames) {
    const contents = fs.readFileSync(path.join(outDir, name));
    assets[name] = {
      size: contents.length,
      sha256: digest(contents, 'sha256', 'hex'),
    };
  }
  fs.writeFileSync(
    path.join(outDir, 'release-provenance.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      product: 'Music Box Internal',
      version: packageMetadata.version,
      architecture: 'arm64',
      bundleId: packageMetadata.build.appId,
      appleTeamId: 'MULN9RP9V5',
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      assets,
    }, null, 2)}\n`,
  );
}

function fixture({ preFeed = false } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-release-gate-'));
  const version = packageMetadata.version;
  const baseName = expectedBaseName(version);
  const zip = { url: `${baseName}.zip`, contents: Buffer.from('zip fixture') };
  const dmg = { url: `${baseName}.dmg`, contents: Buffer.from('dmg fixture') };
  const zipPath = path.join(outDir, zip.url);
  const dmgPath = path.join(outDir, dmg.url);
  fs.writeFileSync(zipPath, zip.contents);
  fs.writeFileSync(dmgPath, dmg.contents);
  writeBlockmap(zipPath);
  if (preFeed) writeBlockmap(dmgPath);

  const feed = {
    version,
    files: [{
      url: zip.url,
      sha512: sha512(zip.contents),
      size: zip.contents.length,
    }],
    path: zip.url,
    sha512: sha512(zip.contents),
  };
  fs.writeFileSync(
    path.join(outDir, 'latest-mac.yml'),
    yaml.dump(feed, { lineWidth: -1, noRefs: true }),
  );
  if (!preFeed) {
    writeFixtureProvenance(outDir, [
      zip.url,
      `${zip.url}.blockmap`,
      dmg.url,
      'latest-mac.yml',
    ]);
  }
  return { dmgPath, feed, outDir, zipPath };
}

function jsonResponse(status, body, url) {
  return {
    headers: { get: () => null },
    status,
    statusText: '',
    url,
    text: async () => JSON.stringify(body),
  };
}

function binaryResponse(status, contents, url) {
  const buffer = Buffer.from(contents);
  return {
    arrayBuffer: async () => buffer,
    body: null,
    headers: { get: () => null },
    status,
    statusText: '',
    url,
  };
}

function fakeGitHub({
  version = packageMetadata.version,
  failUploadNumber = null,
  privateRepo = false,
  stableVersions = [],
  stableTags = [],
  raceVersion = null,
  postPublishRaceVersion = null,
  corruptDownloadName = null,
} = {}) {
  const calls = [];
  const uploaded = [];
  const uploadedContents = new Map();
  let uploadNumber = 0;
  let releaseListNumber = 0;
  let postPublishRaceVisible = false;
  const tag = `v${version}`;
  let release = null;
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const headerEntries = options.headers instanceof Headers
      ? [...options.headers.entries()]
      : Object.entries(options.headers || {});
    const authorized = headerEntries.some(
      ([name]) => String(name).toLowerCase() === 'authorization',
    );
    calls.push({ authorized, headers: Object.fromEntries(headerEntries), method, url });

    if (method === 'GET' && parsed.pathname === '/repos/test/releases') {
      return jsonResponse(200, {
        archived: false,
        disabled: false,
        full_name: 'test/releases',
        private: privateRepo,
        visibility: privateRepo ? 'private' : 'public',
      }, url);
    }
    if (method === 'GET' && parsed.pathname === '/repos/test/releases/releases') {
      releaseListNumber += 1;
      const versions = [...stableVersions];
      if (raceVersion && releaseListNumber > 1) versions.push(raceVersion);
      if (postPublishRaceVisible) versions.push(postPublishRaceVersion);
      const releases = versions.map((stableVersion, index) => ({
        draft: false,
        id: 500 + index,
        prerelease: false,
        tag_name: `v${stableVersion}`,
      }));
      if (release) releases.push(release);
      return jsonResponse(200, releases, url);
    }
    if (method === 'GET' && parsed.pathname === '/repos/test/releases/tags') {
      return jsonResponse(
        200,
        [...stableVersions, ...stableTags]
          .map(stableVersion => ({ name: `v${stableVersion}` })),
        url,
      );
    }
    if (method === 'GET' && parsed.pathname.endsWith('/releases/latest')) {
      if (!release || release.draft !== false) {
        return jsonResponse(404, { message: 'Not Found' }, url);
      }
      return jsonResponse(200, {
        ...release,
        assets: uploaded.map(asset => ({
          ...asset,
          browser_download_url:
            `https://github.com/test/releases/releases/download/${tag}/` +
            encodeURIComponent(asset.name),
        })),
      }, url);
    }
    if (method === 'GET' && parsed.pathname.endsWith(`/releases/tags/${tag}`)) {
      return release
        ? jsonResponse(200, release, url)
        : jsonResponse(404, { message: 'Not Found' }, url);
    }
    if (method === 'POST' && parsed.hostname === 'api.github.com') {
      release = {
        id: 123,
        tag_name: tag,
        draft: true,
        prerelease: false,
        upload_url:
          'https://uploads.github.com/repos/test/releases/releases/123/assets{?name,label}',
        html_url: 'https://github.com/test/releases/123',
      };
      return jsonResponse(201, release, url);
    }
    if (method === 'POST' && parsed.hostname === 'uploads.github.com') {
      uploadNumber += 1;
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      if (uploadNumber === failUploadNumber) {
        return jsonResponse(502, { message: 'upstream failed' }, url);
      }
      const contents = Buffer.concat(chunks);
      const asset = {
        name: parsed.searchParams.get('name'),
        size: contents.length,
        state: 'uploaded',
        digest: `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`,
      };
      uploaded.push(asset);
      uploadedContents.set(asset.name, contents);
      return jsonResponse(201, asset, url);
    }
    if (method === 'GET' && parsed.pathname.endsWith('/releases/123/assets')) {
      return jsonResponse(200, uploaded, url);
    }
    if (method === 'PATCH' && parsed.pathname.endsWith('/releases/123')) {
      release = { ...release, draft: false };
      postPublishRaceVisible = Boolean(postPublishRaceVersion);
      return jsonResponse(200, release, url);
    }
    if (
      method === 'GET' &&
      parsed.hostname === 'github.com' &&
      (
        parsed.pathname.startsWith(`/test/releases/releases/download/${tag}/`) ||
        parsed.pathname === '/test/releases/releases/latest/download/latest-mac.yml'
      )
    ) {
      const name = parsed.pathname.endsWith('/latest-mac.yml')
        ? 'latest-mac.yml'
        : decodeURIComponent(parsed.pathname.split('/').at(-1));
      const contents = uploadedContents.get(name);
      if (!contents) return binaryResponse(404, '', url);
      const delivered = name === corruptDownloadName
        ? Buffer.concat([contents, Buffer.from('corrupt')])
        : contents;
      return binaryResponse(200, delivered, url);
    }
    return jsonResponse(500, { message: `unexpected request: ${method} ${url}` }, url);
  };
  return { calls, fetchImpl, uploaded, uploadedContents };
}

test('build config pins deterministic updater artifact names', () => {
  assert.equal(
    packageMetadata.build.artifactName,
    'Music-Box-Internal-${version}-${arch}.${ext}',
  );
  assert.equal(packageMetadata.build.forceCodeSigning, true);
  assert.equal(packageMetadata.build.afterPack, 'tests/harden-electron-fuses.js');
  assert.equal(packageMetadata.build.afterAllArtifactBuild, 'tests/release-artifact-gate.js');
  assert.equal(packageMetadata.build.dmg.sign, true);
  assert.equal(packageMetadata.build.publish.provider, 'github');
  assert.equal(packageMetadata.build.publish.owner, 'drummerisaiah15-eng');
  assert.equal(packageMetadata.build.publish.repo, 'music-box-internal-releases');
  assert.equal(packageMetadata.scripts['build:release'], undefined);
  assert.equal(packageMetadata.scripts['publish:verified'], undefined);
  assert.match(packageMetadata.scripts['release:build:internal'], /--publish never/);
  assert.match(packageMetadata.scripts['release:build:internal'], /process\.env\.GH_TOKEN/);
  assert.match(
    packageMetadata.scripts['release:build:internal'],
    /MUSIC_BOX_SOURCE_CONTENT_MANIFEST/,
  );
  assert.equal(packageMetadata.devDependencies['@electron/fuses'], '1.8.0');
  assert.equal(packageMetadata.devDependencies['@electron/asar'], '3.4.1');
  assert.ok(packageMetadata.build.files.includes('pdf-worker.js'));
  // MB161-029: spreadsheet-worker.js is gone with the file importer.
  assert.ok(!packageMetadata.build.files.includes('spreadsheet-worker.js'));
  assert.ok(
    packageMetadata.build.asarUnpack.includes('node_modules/@napi-rs/canvas/**'),
  );
  assert.ok(
    packageMetadata.build.asarUnpack.includes(
      'node_modules/@napi-rs/canvas-darwin-arm64/**',
    ),
  );
});

test('release gate exposes the hook shape electron-builder loads', () => {
  assert.equal(typeof releaseArtifactGate, 'function');
});

test('afterPack hardening applies the required fail-closed Electron fuses', async () => {
  let receivedContext = null;
  let receivedConfig = null;
  const context = {
    electronPlatformName: 'darwin',
    packager: {
      async addElectronFuses(actualContext, config) {
        receivedContext = actualContext;
        receivedConfig = config;
      },
    },
  };

  await hardenElectronFuses(context);
  assert.equal(receivedContext, context);
  assert.equal(receivedConfig, FUSE_CONFIG);
  assert.equal(FUSE_CONFIG.version, FuseVersion.V1);
  assert.equal(FUSE_CONFIG.resetAdHocDarwinSignature, true);
  assert.equal(FUSE_CONFIG[FuseV1Options.RunAsNode], false);
  assert.equal(FUSE_CONFIG[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(FUSE_CONFIG[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(FUSE_CONFIG[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(FUSE_CONFIG[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(FUSE_CONFIG[FuseV1Options.OnlyLoadAppFromAsar], true);
  await assert.rejects(
    hardenElectronFuses({ ...context, electronPlatformName: 'linux' }),
    /only supports the macOS release target/,
  );
});

test('release verification rejects a packaged app with a reopened fuse', async () => {
  const disabled = '0'.charCodeAt(0);
  const enabled = '1'.charCodeAt(0);
  const secureWire = {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: disabled,
    [FuseV1Options.EnableCookieEncryption]: enabled,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: disabled,
    [FuseV1Options.EnableNodeCliInspectArguments]: disabled,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: enabled,
    [FuseV1Options.OnlyLoadAppFromAsar]: enabled,
  };
  await assert.doesNotReject(
    verifyElectronFuses('/fixture/Music Box Internal.app', async () => secureWire),
  );
  await assert.rejects(
    verifyElectronFuses('/fixture/Music Box Internal.app', async () => ({
      ...secureWire,
      [FuseV1Options.RunAsNode]: enabled,
    })),
    /RunAsNode is not fail-closed/,
  );
});

test('release verification requires the PDF worker and unpacked arm64 canvas runtime', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-packaged-pdf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'Music Box Internal.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const nativeCanvas = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@napi-rs',
    'canvas-darwin-arm64',
    'skia.darwin-arm64.node',
  );
  fs.mkdirSync(path.dirname(nativeCanvas), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture');
  fs.writeFileSync(nativeCanvas, 'native fixture');

  const entries = [
    '/main.js',
    '/preload.js',
    '/pdf-worker.js',
    '/spreadsheet-worker.js',
    '/node_modules/pdf-parse/package.json',
    '/node_modules/@napi-rs/canvas/package.json',
    '/node_modules/@napi-rs/canvas-darwin-arm64/package.json',
  ];
  assert.doesNotThrow(() => verifyPackagedPdfRuntime(appPath, () => entries));
  assert.throws(
    () => verifyPackagedPdfRuntime(
      appPath,
      () => entries.filter(entry => entry !== '/pdf-worker.js'),
    ),
    /missing pdf-worker\.js/,
  );
});

test('release verification binds packaged first-party bytes to the pre-build manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-source-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const appPath = path.join(root, 'Music Box Internal.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const sourceFiles = new Map([
    ['main.js', Buffer.from('trusted main')],
    ['pdf-worker.js', Buffer.from('trusted worker')],
    ['preload.js', Buffer.from('trusted preload')],
    ['spreadsheet-worker.js', Buffer.from('trusted spreadsheet worker')],
    ['index.html', Buffer.from('<!doctype html><title>trusted</title>')],
    ['vendor/manifest.json', Buffer.from('{"trusted":true}\n')],
    ['vendor/runtime/trusted.js', Buffer.from('globalThis.trusted = true;\n')],
  ]);
  for (const [relativePath, contents] of sourceFiles) {
    const sourcePath = path.join(sourceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, contents);
  }
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture');
  for (const relativePath of [
    'index.html',
    'vendor/manifest.json',
    'vendor/runtime/trusted.js',
  ]) {
    const packagedPath = path.join(resources, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(packagedPath), { recursive: true });
    fs.writeFileSync(packagedPath, sourceFiles.get(relativePath));
  }

  const manifest = createSourceContentManifest(sourceRoot);
  const asarContents = new Map(
    [...sourceFiles].filter(([relativePath]) =>
      ['main.js', 'pdf-worker.js', 'preload.js', 'spreadsheet-worker.js'].includes(relativePath)),
  );
  const extractAsarFile = (asarPath, relativePath) => {
    assert.equal(asarPath, path.join(resources, 'app.asar'));
    if (!asarContents.has(relativePath)) throw new Error('missing fixture entry');
    return asarContents.get(relativePath);
  };
  assert.doesNotThrow(() =>
    verifyPackagedFirstPartyContent(
      appPath,
      manifest,
      extractAsarFile,
      sourceRoot,
    ));

  asarContents.set('main.js', Buffer.from('tampered main'));
  assert.throws(
    () => verifyPackagedFirstPartyContent(
      appPath,
      manifest,
      extractAsarFile,
      sourceRoot,
    ),
    /does not match source: main\.js/,
  );
  asarContents.set('main.js', sourceFiles.get('main.js'));

  fs.writeFileSync(path.join(resources, 'vendor', 'unexpected.js'), 'unexpected');
  assert.throws(
    () => verifyPackagedFirstPartyContent(
      appPath,
      manifest,
      extractAsarFile,
      sourceRoot,
    ),
    /vendor content does not match/,
  );
  fs.rmSync(path.join(resources, 'vendor', 'unexpected.js'));

  fs.writeFileSync(path.join(sourceRoot, 'preload.js'), 'source changed after manifest');
  assert.throws(
    () => verifySourceContentManifest(manifest, sourceRoot),
    /source content changed after manifest creation: preload\.js/,
  );
});

test('release verification pins the packaged updater GitHub configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-updater-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'Music Box Internal.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const configPath = path.join(resources, 'app-update.yml');
  fs.mkdirSync(resources, { recursive: true });
  const validConfig = {
    owner: 'drummerisaiah15-eng',
    repo: 'music-box-internal-releases',
    provider: 'github',
    releaseType: 'release',
    updaterCacheDirName: 'music-box-internal-updater',
  };
  fs.writeFileSync(configPath, yaml.dump(validConfig));

  assert.deepEqual(
    verifyPackagedUpdaterConfig(appPath, packageMetadata),
    validConfig,
  );
  fs.writeFileSync(configPath, yaml.dump({ ...validConfig, repo: 'lookalike-releases' }));
  assert.throws(
    () => verifyPackagedUpdaterConfig(appPath, packageMetadata),
    /exact public GitHub release schema/,
  );

  for (const hostileOption of [
    { host: 'attacker.example' },
    { protocol: 'http' },
    { private: true },
    { token: 'embedded-secret' },
    { channel: 'attacker-channel' },
    { tagNamePrefix: 'attacker-' },
    { vPrefixedTagName: false },
    { requestHeaders: { Authorization: 'attacker' } },
  ]) {
    fs.writeFileSync(configPath, yaml.dump({ ...validConfig, ...hostileOption }));
    assert.throws(
      () => verifyPackagedUpdaterConfig(appPath, packageMetadata),
      /exact public GitHub release schema/,
    );
  }

  fs.writeFileSync(configPath, yaml.dump(validConfig));
  assert.throws(
    () => verifyPackagedUpdaterConfig(appPath, {
      ...packageMetadata,
      build: {
        ...packageMetadata.build,
        publish: {
          ...packageMetadata.build.publish,
          host: 'attacker.example',
        },
      },
    }),
    /exact public GitHub release schema/,
  );
});

test('release verification enforces nested helper team and entitlement policy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-helper-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'Music Box Internal.app');
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  for (const name of [
    'Music Box Internal Helper.app',
    'Music Box Internal Helper (GPU).app',
    'Music Box Internal Helper (Plugin).app',
    'Music Box Internal Helper (Renderer).app',
  ]) {
    fs.mkdirSync(path.join(frameworks, name), { recursive: true });
  }
  const entitlementXml = forbidden => `<?xml version="1.0"?>
<plist><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>
  ${forbidden
    ? '<key>com.apple.security.cs.disable-library-validation</key><true/>'
    : ''}
</dict></plist>`;
  const execute = (command, args) => {
    assert.equal(command, '/usr/bin/codesign');
    if (args[0] === '-dv') {
      return 'flags=0x10000(runtime) TeamIdentifier=MULN9RP9V5';
    }
    if (args[0] === '-d') return entitlementXml(false);
    return '';
  };
  assert.doesNotThrow(
    () => verifyNestedHelperPolicies(appPath, 'MULN9RP9V5', execute),
  );
  assert.throws(
    () => verifyNestedHelperPolicies(
      appPath,
      'MULN9RP9V5',
      (command, args) => (
        args[0] === '-dv'
          ? 'flags=0x10000(runtime) TeamIdentifier=MULN9RP9V5'
          : args[0] === '-d' ? entitlementXml(true) : ''
      ),
    ),
    /forbidden entitlement/,
  );
});

test('DMG verification mounts read-only, verifies the shipped app, and always detaches', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-dmg-mount-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dmgPath = path.join(root, 'fixture.dmg');
  fs.writeFileSync(dmgPath, 'dmg');
  const calls = [];
  let verified = 0;
  const execute = (command, args) => {
    assert.equal(command, '/usr/bin/hdiutil');
    calls.push([...args]);
    if (args[0] === 'attach') {
      const mountPoint = args[args.indexOf('-mountpoint') + 1];
      fs.mkdirSync(path.join(mountPoint, 'Music Box Internal.app'));
    } else if (args[0] === 'detach') {
      fs.rmSync(path.join(args[1], 'Music Box Internal.app'), {
        recursive: true,
        force: true,
      });
    }
    return '';
  };
  await verifyDmgContents(
    dmgPath,
    packageMetadata,
    'MULN9RP9V5',
    execute,
    async (appPath, metadata, teamId, receivedExecute) => {
      verified += 1;
      assert.match(appPath, /Music Box Internal\.app$/);
      assert.equal(metadata, packageMetadata);
      assert.equal(teamId, 'MULN9RP9V5');
      assert.equal(receivedExecute, execute);
    },
  );
  assert.equal(verified, 1);
  assert.deepEqual(calls[0].slice(0, 4), [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
  ]);
  assert.equal(calls.at(-1)[0], 'detach');

  calls.length = 0;
  await assert.rejects(
    verifyDmgContents(
      dmgPath,
      packageMetadata,
      'MULN9RP9V5',
      execute,
      async () => {
        throw new Error('shipped app failed validation');
      },
    ),
    /shipped app failed validation/,
  );
  assert.equal(calls.at(-1)[0], 'detach');
});

test('pre-feed build gate requires the exact ZIP, DMG, and blockmaps', t => {
  const { dmgPath, outDir, zipPath } = fixture({ preFeed: true });
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const artifactPaths = [zipPath, dmgPath];
  assert.deepEqual(
    verifyBuildArtifacts(outDir, artifactPaths, packageMetadata).sort(),
    artifactPaths.sort(),
  );

  fs.rmSync(`${artifactPaths[0]}.blockmap`);
  assert.throws(
    () => verifyBuildArtifacts(outDir, artifactPaths, packageMetadata),
    /missing exact updater blockmap/,
  );
});

test('failed publication restores both version files byte-for-byte', t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-release-script-'));
  const projectDir = path.join(fixtureRoot, 'project');
  const fakeBin = path.join(fixtureRoot, 'fake-bin');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(path.join(projectDir, 'tests'));
  fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(projectDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'node_modules', 'tampered-release-input'),
    'must never enter isolated release source',
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const name of ['release.sh', 'package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(__dirname, '..', name), path.join(projectDir, name));
  }
  const fakePublisher = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const appleCredentialNames = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_KEYCHAIN',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];
fs.appendFileSync(process.env.FAKE_PUBLISHER_LOG, JSON.stringify({
  args: process.argv.slice(2),
  appleCredentialNames: appleCredentialNames.filter(name =>
    Object.hasOwn(process.env, name)),
  hasGithubToken: Boolean(process.env.GH_TOKEN),
  hasReleaseToken: Object.hasOwn(process.env, 'RELEASE_GH_TOKEN'),
  path: process.env.PATH,
}) + '\\n');
process.exit(process.argv[2] === '--check-version' ? 0 : 51);
`;
  fs.writeFileSync(
    path.join(projectDir, 'tests', 'publish-verified-release.js'),
    fakePublisher,
  );
  const fakeGate = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const appleCredentialNames = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_KEYCHAIN',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];
fs.appendFileSync(process.env.FAKE_GATE_LOG, JSON.stringify({
  args: process.argv.slice(2),
  appleCredentialNames: appleCredentialNames.filter(name =>
    Object.hasOwn(process.env, name)),
  hasGithubToken: Object.hasOwn(process.env, 'GH_TOKEN'),
  hasReleaseToken: Object.hasOwn(process.env, 'RELEASE_GH_TOKEN'),
  path: process.env.PATH,
}) + '\\n');
fs.writeFileSync(process.argv[3], '{}\\n');
`;
  fs.writeFileSync(
    path.join(projectDir, 'tests', 'release-artifact-gate.js'),
    fakeGate,
  );

  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    ['-c', 'user.name=Release Test', '-c', 'user.email=release@test.invalid',
      'commit', '--quiet', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const originalPackage = fs.readFileSync(path.join(projectDir, 'package.json'));
  const originalLockfile = fs.readFileSync(path.join(projectDir, 'package-lock.json'));
  const npmLogPath = path.join(fixtureRoot, 'npm-log.jsonl');
  const publisherLogPath = path.join(fixtureRoot, 'publisher-log.jsonl');
  const gateLogPath = path.join(fixtureRoot, 'gate-log.jsonl');

  const fakeNpm = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  driver: process.env.MUSIC_BOX_RELEASE_DRIVER || '',
  hasAppleCredential: Boolean(
    process.env.APPLE_KEYCHAIN_PROFILE ||
    process.env.APPLE_API_KEY ||
    process.env.APPLE_API_KEY_ID ||
    process.env.APPLE_API_ISSUER
  ),
  hasGithubToken: Boolean(process.env.GH_TOKEN),
  hasReleaseToken: Boolean(process.env.RELEASE_GH_TOKEN),
  sourceManifestPath: process.env.MUSIC_BOX_SOURCE_CONTENT_MANIFEST || '',
  sourceManifestExists: Boolean(
    process.env.MUSIC_BOX_SOURCE_CONTENT_MANIFEST &&
    fs.existsSync(process.env.MUSIC_BOX_SOURCE_CONTENT_MANIFEST)
  ),
  path: process.env.PATH,
}) + '\\n');
if (
  args[0] === 'ci' ||
  args[0] === 'test' ||
  (args[0] === 'run' && args[1] === 'vendor:prepare')
) {
  process.exit(0);
}
if (args[0] === 'version') {
  const version = args[1];
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(process.cwd(), name);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.version = version;
    if (json.packages && json.packages['']) json.packages[''].version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\\n');
  }
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'release:build:internal') {
  if (process.cwd() === process.env.FIXTURE_MAIN_PROJECT) process.exit(52);
  if (fs.existsSync(path.join(process.cwd(), 'node_modules', 'tampered-release-input'))) {
    process.exit(53);
  }
  if (process.env.MUSIC_BOX_RELEASE_DRIVER !== '1') process.exit(54);
  process.exit(0);
}
process.exit(2);
`;
  fs.writeFileSync(path.join(fakeBin, 'npm'), fakeNpm, { mode: 0o755 });
  for (const tool of ['codesign', 'spctl', 'xcrun']) {
    fs.writeFileSync(path.join(fakeBin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const result = spawnSync('bash', ['release.sh', 'patch'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: projectDir,
      TMPDIR: fixtureRoot,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_NPM_LOG: npmLogPath,
      FAKE_PUBLISHER_LOG: publisherLogPath,
      FAKE_GATE_LOG: gateLogPath,
      FIXTURE_MAIN_PROJECT: projectDir,
      APPLE_ID: '',
      APPLE_APP_SPECIFIC_PASSWORD: '',
      APPLE_API_KEY: '',
      APPLE_API_KEY_ID: '',
      APPLE_API_ISSUER: '',
      APPLE_TEAM_ID: 'MULN9RP9V5',
      APPLE_KEYCHAIN_PROFILE: 'music-box-release-test',
      APPLE_KEYCHAIN: 'music-box-test-keychain',
      GH_TOKEN: 'not-a-real-token',
      RELEASE_GH_TOKEN: 'must-not-be-inherited',
    },
  });

  assert.equal(result.status, 51, result.stderr || result.stdout);
  assert.match(result.stderr, /restoring package\.json and package-lock\.json/);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'package.json')), originalPackage);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'package-lock.json')), originalLockfile);
  const npmCalls = fs.readFileSync(npmLogPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const cleanInstall = npmCalls.find(call => call.args[0] === 'ci');
  assert.ok(cleanInstall);
  assert.notEqual(cleanInstall.cwd, projectDir);
  for (const call of npmCalls) {
    assert.equal(call.hasGithubToken, false);
    assert.equal(call.hasReleaseToken, false);
    assert.match(call.path, /^\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:/);
  }
  const uncredentialedCalls = npmCalls.filter(call =>
    call.args[0] === 'ci' ||
    call.args[0] === 'test' ||
    (call.args[0] === 'run' && call.args[1] === 'vendor:prepare'));
  for (const call of uncredentialedCalls) {
    assert.notEqual(call.cwd, projectDir);
    assert.equal(call.hasAppleCredential, false);
  }
  const internalBuild = npmCalls.find(
    call => call.args[0] === 'run' && call.args[1] === 'release:build:internal',
  );
  assert.ok(internalBuild);
  assert.notEqual(internalBuild.cwd, projectDir);
  assert.equal(internalBuild.hasGithubToken, false);
  assert.equal(internalBuild.hasAppleCredential, true);
  assert.equal(internalBuild.sourceManifestExists, true);
  assert.ok(path.isAbsolute(internalBuild.sourceManifestPath));

  const publisherCalls = fs.readFileSync(publisherLogPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const [releaseMajor, releaseMinor, releasePatch] = packageMetadata.version
    .split('.')
    .map(Number);
  const expectedNextVersion = `${releaseMajor}.${releaseMinor}.${releasePatch + 1}`;
  assert.equal(publisherCalls.length, 2);
  assert.deepEqual(
    publisherCalls[0].args,
    ['--check-version', expectedNextVersion],
  );
  assert.equal(publisherCalls[1].args.length, 1);
  for (const call of publisherCalls) {
    assert.deepEqual(call.appleCredentialNames, []);
    assert.equal(call.hasGithubToken, true);
    assert.equal(call.hasReleaseToken, false);
    assert.match(call.path, /^\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:/);
  }

  const gateCalls = fs.readFileSync(gateLogPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0].args[0], '--write-source-manifest');
  assert.deepEqual(gateCalls[0].appleCredentialNames, []);
  assert.equal(gateCalls[0].hasGithubToken, false);
  assert.equal(gateCalls[0].hasReleaseToken, false);
});

test('release gate accepts an exact feed/artifact/blockmap set', async t => {
  const { outDir } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  await assert.doesNotReject(verifyFeedArtifacts(outDir, packageMetadata));
});

test('release gate rejects the historical ZIP/blockmap naming mismatch', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  fs.renameSync(
    path.join(outDir, `${feed.path}.blockmap`),
    path.join(
      outDir,
      `${feed.path.replace('Music-Box-Internal', 'Music.Box.Internal')}.blockmap`,
    ),
  );
  await assert.rejects(
    verifyFeedArtifacts(outDir, packageMetadata),
    /missing exact updater blockmap/,
  );
});

test('release gate rejects feed files with ambiguous names', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  feed.files[0].url = `Music Box Internal-${packageMetadata.version}-arm64.zip`;
  fs.writeFileSync(
    path.join(outDir, 'latest-mac.yml'),
    yaml.dump(feed, { lineWidth: -1, noRefs: true }),
  );
  await assert.rejects(
    verifyFeedArtifacts(outDir, packageMetadata),
    /updater feed must reference exactly/,
  );
});

test('verified publisher keeps the release draft until every asset is confirmed', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const github = fakeGitHub();
  const assets = await snapshotReleaseAssets(expectedReleaseAssets(outDir, feed));

  const published = await publishAssetsToDraft({
    outDir,
    feed,
    version: packageMetadata.version,
    owner: 'test',
    repo: 'releases',
    token: 'not-a-real-token',
    sourceCommit: SOURCE_COMMIT,
    assets,
    fetchImpl: github.fetchImpl,
  });

  assert.equal(published.draft, false);
  assert.equal(github.uploaded.length, assets.length);
  assert.deepEqual(
    github.uploaded.map(asset => asset.name),
    assets.map(asset => asset.name),
  );
  const publishIndex = github.calls.findIndex(call => call.method === 'PATCH');
  const prePublishConfirmationIndex = github.calls.findIndex(call =>
    call.method === 'GET' && new URL(call.url).pathname.endsWith('/releases/123/assets'),
  );
  assert.ok(prePublishConfirmationIndex >= 0);
  assert.ok(publishIndex > prePublishConfirmationIndex);
  assert.equal(github.calls.at(-1).method, 'GET');
  const anonymousCalls = github.calls.filter(call =>
    call.url.includes('/releases/latest') ||
    new URL(call.url).hostname === 'github.com');
  assert.equal(anonymousCalls.length, 4);
  assert.ok(anonymousCalls.every(call => call.authorized === false));
  assert.deepEqual(
    anonymousCalls
      .filter(call => new URL(call.url).hostname === 'github.com')
      .map(call => decodeURIComponent(new URL(call.url).pathname.split('/').at(-1))),
    ['latest-mac.yml', feed.path, `${feed.path}.blockmap`],
  );
});

test('failed asset upload never publishes the draft release', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const github = fakeGitHub({ failUploadNumber: 2 });
  const assets = await snapshotReleaseAssets(expectedReleaseAssets(outDir, feed));

  await assert.rejects(
    publishAssetsToDraft({
      outDir,
      feed,
      version: packageMetadata.version,
      owner: 'test',
      repo: 'releases',
      token: 'not-a-real-token',
      sourceCommit: SOURCE_COMMIT,
      assets,
      fetchImpl: github.fetchImpl,
    }),
    /remains unpublished/,
  );
  assert.equal(github.calls.some(call => call.method === 'PATCH'), false);
});

test('verified publisher refuses a private update repository before creating a release', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const github = fakeGitHub({ privateRepo: true });
  const assets = await snapshotReleaseAssets(expectedReleaseAssets(outDir, feed));

  await assert.rejects(
    publishAssetsToDraft({
      outDir,
      feed,
      version: packageMetadata.version,
      owner: 'test',
      repo: 'releases',
      token: 'not-a-real-token',
      sourceCommit: SOURCE_COMMIT,
      assets,
      fetchImpl: github.fetchImpl,
    }),
    /active public update repository/,
  );
  assert.equal(github.calls.some(call => call.method === 'POST'), false);
});

test('version gate considers every stable release instead of trusting latest ordering', async () => {
  const github = fakeGitHub({
    stableVersions: ['1.0.1', '2.4.0'],
    stableTags: ['9.0.0'],
  });
  await assert.rejects(
    assertVersionIsNewerThanGitHub({
      version: packageMetadata.version,
      owner: 'test',
      repo: 'releases',
      token: 'not-a-real-token',
      fetchImpl: github.fetchImpl,
    }),
    /must be greater than GitHub latest 9\.0\.0/,
  );
});

test('verified publisher rechecks version monotonicity immediately before publish', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const github = fakeGitHub({ raceVersion: '9.0.0' });
  const assets = await snapshotReleaseAssets(expectedReleaseAssets(outDir, feed));

  await assert.rejects(
    publishAssetsToDraft({
      outDir,
      feed,
      version: packageMetadata.version,
      owner: 'test',
      repo: 'releases',
      token: 'not-a-real-token',
      sourceCommit: SOURCE_COMMIT,
      assets,
      fetchImpl: github.fetchImpl,
    }),
    /remains unpublished/,
  );
  assert.equal(github.calls.some(call => call.method === 'PATCH'), false);
  assert.equal(
    fs.readFileSync(path.join(outDir, '.publication-state'), 'utf8').trim(),
    'draft',
  );
});

test('post-public verification rejects a lower release that won the latest race', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const github = fakeGitHub({ postPublishRaceVersion: '9.0.0' });
  const assets = await snapshotReleaseAssets(expectedReleaseAssets(outDir, feed));

  await assert.rejects(
    publishAssetsToDraft({
      outDir,
      feed,
      version: packageMetadata.version,
      owner: 'test',
      repo: 'releases',
      token: 'not-a-real-token',
      sourceCommit: SOURCE_COMMIT,
      assets,
      fetchImpl: github.fetchImpl,
    }),
    /not the strict maximum stable GitHub version; maximum is 9\.0\.0/,
  );
  assert.equal(github.calls.some(call => call.method === 'PATCH'), true);
  assert.equal(
    fs.readFileSync(path.join(outDir, '.publication-state'), 'utf8').trim(),
    'unknown',
  );
});

test('public release is not confirmed when anonymous updater bytes differ', async t => {
  const { outDir, feed } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const github = fakeGitHub({ corruptDownloadName: feed.path });
  const assets = await snapshotReleaseAssets(expectedReleaseAssets(outDir, feed));

  await assert.rejects(
    publishAssetsToDraft({
      outDir,
      feed,
      version: packageMetadata.version,
      owner: 'test',
      repo: 'releases',
      token: 'not-a-real-token',
      sourceCommit: SOURCE_COMMIT,
      assets,
      fetchImpl: github.fetchImpl,
    }),
    /release is public but post-public validation failed/,
  );
  assert.equal(github.calls.some(call => call.method === 'PATCH'), true);
  assert.equal(
    fs.readFileSync(path.join(outDir, '.publication-state'), 'utf8').trim(),
    'unknown',
  );
});

test('all packaged browser libraries come from pinned local bundles', () => {
  assert.equal(packageMetadata.devDependencies.firebase, '12.15.0');
  assert.equal(
    packageMetadata.devDependencies.xlsx,
    'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  );
  assert.ok(
    packageMetadata.build.extraResources.some(resource =>
      resource.from === 'vendor' && resource.to === 'vendor'),
  );
});

test('release gate fails when the DMG container is unsigned', t => {
  const { dmgPath, outDir } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const appPath = path.join(outDir, 'mac-arm64', 'Music Box Internal.app');
  fs.mkdirSync(appPath, { recursive: true });

  assert.throws(
    () => verifyMacDistribution(outDir, [dmgPath], (command, args) => {
      if (command === '/usr/bin/codesign' && args.at(-1) === dmgPath) {
        throw new Error('DMG is not signed at all');
      }
    }),
    /not signed/,
  );
});

test('release gate fails when the DMG has no stapled notarization ticket', t => {
  const { dmgPath, outDir } = fixture();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const appPath = path.join(outDir, 'mac-arm64', 'Music Box Internal.app');
  fs.mkdirSync(appPath, { recursive: true });

  assert.throws(
    () => verifyMacDistribution(outDir, [dmgPath], (command, args) => {
      if (
        command === '/usr/bin/xcrun' &&
        args[0] === 'stapler' &&
        args.at(-1) === dmgPath
      ) {
        throw new Error('The ticket was not found');
      }
    }),
    /ticket was not found/,
  );
});
