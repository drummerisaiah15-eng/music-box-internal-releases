'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  FuseVersion,
  FuseV1Options,
  getCurrentFuseWire,
} = require('@electron/fuses');
const { extractFile, listPackage } = require('@electron/asar');
const { blake2b } = require('@noble/hashes/blake2.js');
const yaml = require('js-yaml');

const PROJECT_DIR = path.resolve(__dirname, '..');
const PRODUCT_NAME = 'Music Box Internal';
const RELEASE_ARCH = 'arm64';
const PROVENANCE_FILE = 'release-provenance.json';
const EXPECTED_UPDATE_OWNER = 'drummerisaiah15-eng';
const EXPECTED_UPDATE_REPO = 'music-box-internal-releases';
const EXPECTED_UPDATER_CACHE_DIR_NAME = 'music-box-internal-updater';
const SOURCE_CONTENT_MANIFEST_SCHEMA = 1;
const FIRST_PARTY_ASAR_FILES = [
  'main.js',
  'pdf-worker.js',
  'preload.js',
];
const FIRST_PARTY_RESOURCE_FILES = ['index.html'];
const EXACT_PUBLISH_KEYS = [
  'owner',
  'provider',
  'releaseType',
  'repo',
];
const EXACT_PACKAGED_UPDATE_KEYS = [
  'owner',
  'provider',
  'releaseType',
  'repo',
  'updaterCacheDirName',
];
const CODESIGN = '/usr/bin/codesign';
const SPCTL = '/usr/sbin/spctl';
const XCRUN = '/usr/bin/xcrun';
const HDIUTIL = '/usr/bin/hdiutil';
const PLUTIL = '/usr/bin/plutil';
const LIPO = '/usr/bin/lipo';
const UNZIP = '/usr/bin/unzip';
const DITTO = '/usr/bin/ditto';
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.network.client',
  'com.apple.security.network.server',
];
const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.get-task-allow',
];

function fail(message) {
  throw new Error(`Release verification failed: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    fail(`${command} ${args[0] || ''}: ${detail || `exit ${result.status}`}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function fileDigest(filePath, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest(encoding)));
  });
}

function sha512(filePath) {
  return fileDigest(filePath, 'sha512', 'base64');
}

function sha256(filePath) {
  return fileDigest(filePath, 'sha256', 'hex');
}

function loadPackage() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
}

function sha256Buffer(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function sortedObjectKeys(value) {
  return Object.keys(value || {}).sort();
}

function sameStringList(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactKeys(value, expectedKeys) {
  const actual = sortedObjectKeys(value);
  const expected = [...expectedKeys].sort();
  return (
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    sameStringList(actual, expected)
  );
}

function listRegularRelativeFiles(rootDir) {
  const files = [];
  const walk = (absoluteDir, relativeDir = '') => {
    let rootStat;
    try {
      rootStat = fs.lstatSync(absoluteDir);
    } catch (error) {
      fail(`could not inspect content directory ${absoluteDir}: ${error.message}`);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail(`content directory must be a real directory: ${absoluteDir}`);
    }

    for (const name of fs.readdirSync(absoluteDir).sort()) {
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, name)
        : name;
      const absolutePath = path.join(absoluteDir, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        fail(`content path must not be a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        fail(`content path must be a regular file or directory: ${relativePath}`);
      }
    }
  };
  walk(rootDir);
  return files.sort();
}

function expectedSourceContentFiles(projectDir = PROJECT_DIR) {
  const files = [
    ...FIRST_PARTY_ASAR_FILES,
    ...FIRST_PARTY_RESOURCE_FILES,
  ];
  const vendorDir = path.join(projectDir, 'vendor');
  for (const relativePath of listRegularRelativeFiles(vendorDir)) {
    if (relativePath.endsWith('.js') || relativePath === 'manifest.json') {
      files.push(path.posix.join('vendor', relativePath));
    }
  }
  return files.sort();
}

function readRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    fail(`${label} is missing: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
  return fs.readFileSync(filePath);
}

function createSourceContentManifest(projectDir = PROJECT_DIR) {
  const files = {};
  for (const relativePath of expectedSourceContentFiles(projectDir)) {
    const contents = readRegularFile(
      path.join(projectDir, ...relativePath.split('/')),
      `source content ${relativePath}`,
    );
    files[relativePath] = {
      size: contents.length,
      sha256: sha256Buffer(contents),
    };
  }
  return {
    schemaVersion: SOURCE_CONTENT_MANIFEST_SCHEMA,
    files,
  };
}

function validateSourceContentManifest(manifest, projectDir = null) {
  if (
    !hasExactKeys(manifest, ['files', 'schemaVersion']) ||
    manifest.schemaVersion !== SOURCE_CONTENT_MANIFEST_SCHEMA ||
    !manifest.files ||
    Object.getPrototypeOf(manifest.files) !== Object.prototype
  ) {
    fail('source-content manifest structure is invalid');
  }

  const manifestFiles = sortedObjectKeys(manifest.files);
  const requiredFiles = [
    ...FIRST_PARTY_ASAR_FILES,
    ...FIRST_PARTY_RESOURCE_FILES,
    'vendor/manifest.json',
  ];
  for (const relativePath of requiredFiles) {
    if (!manifestFiles.includes(relativePath)) {
      fail(`source-content manifest is missing ${relativePath}`);
    }
  }
  if (!manifestFiles.some(relativePath =>
    relativePath.startsWith('vendor/') && relativePath.endsWith('.js'))) {
    fail('source-content manifest must contain the generated vendor JavaScript');
  }
  for (const relativePath of manifestFiles) {
    const isFixedFile = requiredFiles.includes(relativePath);
    const isVendorJavaScript = (
      relativePath.startsWith('vendor/') &&
      relativePath.endsWith('.js')
    );
    if (
      path.posix.normalize(relativePath) !== relativePath ||
      path.posix.isAbsolute(relativePath) ||
      relativePath.includes('\\') ||
      relativePath.split('/').includes('..') ||
      (!isFixedFile && !isVendorJavaScript)
    ) {
      fail(`source-content manifest contains an unsafe or unexpected path: ${relativePath}`);
    }
  }
  if (
    projectDir &&
    !sameStringList(manifestFiles, expectedSourceContentFiles(projectDir))
  ) {
    fail('source-content manifest has an unexpected file set');
  }
  for (const relativePath of manifestFiles) {
    const record = manifest.files[relativePath];
    if (
      !hasExactKeys(record, ['sha256', 'size']) ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      !/^[0-9a-f]{64}$/.test(record.sha256 || '')
    ) {
      fail(`source-content manifest record is invalid for ${relativePath}`);
    }
  }
  return manifest;
}

function verifySourceContentManifest(
  manifest,
  projectDir = PROJECT_DIR,
) {
  validateSourceContentManifest(manifest, projectDir);
  const current = createSourceContentManifest(projectDir);
  for (const relativePath of sortedObjectKeys(manifest.files)) {
    const expected = manifest.files[relativePath];
    const actual = current.files[relativePath];
    if (
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256
    ) {
      fail(`source content changed after manifest creation: ${relativePath}`);
    }
  }
  return manifest;
}

function loadSourceContentManifest(
  manifestPath = process.env.MUSIC_BOX_SOURCE_CONTENT_MANIFEST,
  projectDir = PROJECT_DIR,
) {
  if (!manifestPath || !path.isAbsolute(manifestPath)) {
    fail('MUSIC_BOX_SOURCE_CONTENT_MANIFEST must be an absolute manifest path');
  }
  const contents = readRegularFile(manifestPath, 'source-content manifest');
  if (contents.length < 1 || contents.length > 1024 * 1024) {
    fail('source-content manifest must be a bounded regular file');
  }
  let manifest;
  try {
    manifest = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    fail(`source-content manifest is invalid JSON: ${error.message}`);
  }
  return verifySourceContentManifest(manifest, projectDir);
}

function writeSourceContentManifest(
  manifestPath,
  projectDir = PROJECT_DIR,
) {
  if (!manifestPath || !path.isAbsolute(manifestPath)) {
    fail('source-content manifest output must be an absolute path');
  }
  const manifest = createSourceContentManifest(projectDir);
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function expectedBaseName(version) {
  return `Music-Box-Internal-${version}-${RELEASE_ARCH}`;
}

function expectedArtifactNames(version) {
  const baseName = expectedBaseName(version);
  return {
    zip: `${baseName}.zip`,
    dmg: `${baseName}.dmg`,
    zipBlockmap: `${baseName}.zip.blockmap`,
  };
}

function requireTeamId(env = process.env) {
  const teamId = env.APPLE_TEAM_ID;
  if (!/^[A-Z0-9]{10}$/.test(teamId || '')) {
    fail('APPLE_TEAM_ID must be a 10-character Apple Developer Team ID');
  }
  return teamId;
}

function getNotarizeOptions(appPath, env = process.env) {
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    fail('Apple ID/password notarization is disabled; use a keychain profile or API key');
  }

  const hasProfile = Boolean(env.APPLE_KEYCHAIN_PROFILE);
  const hasApi = Boolean(env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER);
  if (hasProfile && hasApi) fail('multiple notarization credential strategies were provided');

  if (hasProfile) {
    const options = {
      tool: 'notarytool',
      appPath,
      keychainProfile: env.APPLE_KEYCHAIN_PROFILE,
    };
    if (env.APPLE_KEYCHAIN) options.keychain = env.APPLE_KEYCHAIN;
    return options;
  }

  if (hasApi) {
    if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
      fail('APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER must all be set');
    }
    return {
      tool: 'notarytool',
      appPath,
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER,
    };
  }

  fail('notarization requires APPLE_KEYCHAIN_PROFILE or an Apple API key credential set');
}

async function notarizeAndStapleDmg(
  dmgPath,
  env = process.env,
  notarizeImpl = require('@electron/notarize').notarize,
) {
  const options = getNotarizeOptions(dmgPath, env);
  console.log(`Notarizing and stapling DMG container ${path.basename(dmgPath)}...`);
  await notarizeImpl(options);
}

function parseBlockmap(blockmapPath) {
  let parsed;
  try {
    parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(blockmapPath)).toString('utf8'));
  } catch (error) {
    fail(`${path.basename(blockmapPath)} is not a valid gzip-compressed JSON blockmap: ${error.message}`);
  }
  if (
    parsed?.version !== '2' ||
    !Array.isArray(parsed.files) ||
    parsed.files.length !== 1
  ) {
    fail(`${path.basename(blockmapPath)} has an unsupported blockmap structure`);
  }
  return parsed;
}

function verifyBlockmapCorrespondence(artifactPath, blockmapPath = `${artifactPath}.blockmap`) {
  if (!fs.existsSync(blockmapPath)) {
    fail(`missing exact updater blockmap ${path.basename(blockmapPath)}`);
  }
  const blockmap = parseBlockmap(blockmapPath);
  const mappedFile = blockmap.files[0];
  if (
    mappedFile.name !== 'file' ||
    mappedFile.offset !== 0 ||
    !Array.isArray(mappedFile.sizes) ||
    !Array.isArray(mappedFile.checksums) ||
    mappedFile.sizes.length === 0 ||
    mappedFile.sizes.length !== mappedFile.checksums.length
  ) {
    fail(`${path.basename(blockmapPath)} does not describe one complete file`);
  }

  const artifactSize = fs.statSync(artifactPath).size;
  const fd = fs.openSync(artifactPath, 'r');
  let offset = 0;
  try {
    for (let index = 0; index < mappedFile.sizes.length; index += 1) {
      const size = mappedFile.sizes[index];
      const checksum = mappedFile.checksums[index];
      if (!Number.isInteger(size) || size < 1 || size > 32768) {
        fail(`${path.basename(blockmapPath)} contains an invalid chunk size`);
      }
      if (typeof checksum !== 'string' || checksum.length < 20) {
        fail(`${path.basename(blockmapPath)} contains an invalid chunk checksum`);
      }
      const chunk = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(fd, chunk, 0, size, offset);
      if (bytesRead !== size) {
        fail(`${path.basename(blockmapPath)} extends beyond ${path.basename(artifactPath)}`);
      }
      const actual = Buffer.from(blake2b(chunk, { dkLen: 18 })).toString('base64');
      if (actual !== checksum) {
        fail(`${path.basename(blockmapPath)} chunk ${index} does not match the artifact`);
      }
      offset += size;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (offset !== artifactSize) {
    fail(`${path.basename(blockmapPath)} covers ${offset} bytes; artifact has ${artifactSize}`);
  }
  return blockmap;
}

function verifyBuildArtifacts(outDir, artifactPaths, packageMetadata = loadPackage()) {
  const resolvedOutDir = path.resolve(outDir);
  const distributionArtifacts = [...new Set(artifactPaths)]
    .filter(filePath => /\.(?:dmg|zip)$/.test(filePath))
    .map(filePath => path.resolve(filePath));
  if (distributionArtifacts.length !== 2) {
    fail(`build must produce exactly one ZIP and one DMG, found ${distributionArtifacts.length}`);
  }

  const names = expectedArtifactNames(packageMetadata.version);
  const expectedNames = new Set([names.zip, names.dmg]);
  const seenNames = new Set();
  for (const artifactPath of distributionArtifacts) {
    if (path.dirname(artifactPath) !== resolvedOutDir) {
      fail(`distribution artifact escaped the output directory: ${artifactPath}`);
    }
    const name = path.basename(artifactPath);
    if (!expectedNames.has(name)) fail(`unexpected distribution artifact name: ${name}`);
    if (!fs.existsSync(artifactPath)) fail(`distribution artifact does not exist: ${name}`);
    verifyBlockmapCorrespondence(artifactPath);
    seenNames.add(name);
  }
  for (const expectedName of expectedNames) {
    if (!seenNames.has(expectedName)) fail(`build is missing ${expectedName}`);
  }
  return distributionArtifacts;
}

function atomicWrite(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, contents, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

async function finalizeUpdaterFeed(outDir, packageMetadata = loadPackage()) {
  const feedPath = path.join(outDir, 'latest-mac.yml');
  if (!fs.existsSync(feedPath)) fail(`missing ${feedPath}`);
  const feed = yaml.load(fs.readFileSync(feedPath, 'utf8'));
  if (!feed || typeof feed !== 'object') fail('latest-mac.yml is not an object');

  const names = expectedArtifactNames(packageMetadata.version);
  const zipPath = path.join(outDir, names.zip);
  const dmgPath = path.join(outDir, names.dmg);
  if (!fs.existsSync(zipPath) || !fs.existsSync(dmgPath)) {
    fail('final ZIP and DMG must exist before updater metadata is finalized');
  }
  verifyBlockmapCorrespondence(zipPath);

  const zipEntry = Array.isArray(feed.files)
    ? feed.files.find(entry => entry?.url === names.zip)
    : null;
  if (!zipEntry) fail(`pre-finalization feed is missing ${names.zip}`);

  const digest = await sha512(zipPath);
  const size = fs.statSync(zipPath).size;
  const finalFeed = {
    ...feed,
    version: packageMetadata.version,
    files: [{ ...zipEntry, url: names.zip, sha512: digest, size }],
    path: names.zip,
    sha512: digest,
  };
  atomicWrite(feedPath, yaml.dump(finalFeed, { lineWidth: -1, noRefs: true }));

  const staleDmgBlockmap = `${dmgPath}.blockmap`;
  if (fs.existsSync(staleDmgBlockmap)) fs.unlinkSync(staleDmgBlockmap);
  return finalFeed;
}

async function verifyFeedArtifacts(outDir, packageMetadata = loadPackage()) {
  const feedPath = path.join(outDir, 'latest-mac.yml');
  if (!fs.existsSync(feedPath)) fail(`missing ${feedPath}`);

  const feed = yaml.load(fs.readFileSync(feedPath, 'utf8'));
  if (!feed || typeof feed !== 'object') fail('latest-mac.yml is not an object');
  if (feed.version !== packageMetadata.version) {
    fail(`feed version ${feed.version} does not match package ${packageMetadata.version}`);
  }
  if (!Array.isArray(feed.files) || feed.files.length !== 1) {
    fail(`latest-mac.yml must contain exactly one updater ZIP entry`);
  }

  const names = expectedArtifactNames(packageMetadata.version);
  const entry = feed.files[0];
  if (!entry || entry.url !== names.zip || path.basename(entry.url) !== entry.url) {
    fail(`updater feed must reference exactly ${names.zip}`);
  }
  const zipPath = path.join(outDir, names.zip);
  const dmgPath = path.join(outDir, names.dmg);
  if (!fs.existsSync(zipPath)) fail(`feed artifact does not exist: ${names.zip}`);
  if (!fs.existsSync(dmgPath)) fail(`installer artifact does not exist: ${names.dmg}`);
  if (fs.existsSync(`${dmgPath}.blockmap`)) {
    fail('DMG blockmap must be removed after the DMG is stapled');
  }
  if (entry.size !== fs.statSync(zipPath).size) {
    fail(`${names.zip} size does not match latest-mac.yml`);
  }
  const digest = await sha512(zipPath);
  if (entry.sha512 !== digest) fail(`${names.zip} SHA-512 mismatch`);
  if (feed.path !== names.zip || feed.sha512 !== digest) {
    fail('legacy updater path and SHA-512 must match the ZIP entry');
  }
  verifyBlockmapCorrespondence(zipPath);
  return feed;
}

function verifyMacDistribution(outDir, dmgPaths, execute = run) {
  const appPath = findAppBundle(outDir);
  if (!appPath) fail('signed application bundle was not found');

  execute(CODESIGN, ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
  execute(SPCTL, ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  execute(XCRUN, ['stapler', 'validate', appPath]);

  for (const dmgPath of dmgPaths) {
    execute(CODESIGN, ['--verify', '--strict', '--verbose=4', dmgPath]);
    execute(XCRUN, ['stapler', 'validate', dmgPath]);
    execute(SPCTL, [
      '--assess', '--type', 'open',
      '--context', 'context:primary-signature',
      '--verbose=4', dmgPath,
    ]);
  }
}

function findAppBundle(outDir) {
  const candidates = [
    path.join(outDir, 'mac-arm64', `${PRODUCT_NAME}.app`),
    path.join(outDir, 'mac', `${PRODUCT_NAME}.app`),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function validateZipEntries(listing) {
  const entries = String(listing).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) fail('updater ZIP contains no entries');
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      fail(`updater ZIP contains an unsafe path: ${entry}`);
    }
  }
  const appRoots = new Set(
    entries
      .map(entry => entry.replace(/\\/g, '/'))
      .filter(entry => entry.endsWith('.app/') || entry.endsWith('.app'))
      .map(entry => entry.replace(/\/$/, ''))
      .filter(entry => !entry.includes('/')),
  );
  if (appRoots.size !== 1 || !appRoots.has(`${PRODUCT_NAME}.app`)) {
    fail(`updater ZIP must contain exactly one top-level ${PRODUCT_NAME}.app`);
  }
  return entries;
}

function plistBoolean(xml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml).match(
    new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<(true|false)\\s*/>`),
  );
  return match ? match[1] === 'true' : null;
}

function entitlementBoolean(contents, key) {
  const xmlValue = plistBoolean(contents, key);
  if (xmlValue !== null) return xmlValue;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const humanReadableMatch = String(contents).match(
    new RegExp(
      `\\[Key\\]\\s+${escaped}\\s*\\n\\s*` +
      `\\[Value\\]\\s*\\n\\s*\\[Bool\\]\\s+(true|false)`,
    ),
  );
  return humanReadableMatch ? humanReadableMatch[1] === 'true' : null;
}

async function verifyElectronFuses(appPath, readFuseWire = getCurrentFuseWire) {
  let wire;
  try {
    wire = await readFuseWire(appPath);
  } catch (error) {
    fail(`could not read Electron fuses: ${error.message}`);
  }
  if (wire?.version !== FuseVersion.V1) {
    fail(`packaged Electron has unsupported fuse wire version ${wire?.version}`);
  }

  const disabled = '0'.charCodeAt(0);
  const enabled = '1'.charCodeAt(0);
  const expected = [
    [FuseV1Options.RunAsNode, disabled],
    [FuseV1Options.EnableCookieEncryption, enabled],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, disabled],
    [FuseV1Options.EnableNodeCliInspectArguments, disabled],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, enabled],
    [FuseV1Options.OnlyLoadAppFromAsar, enabled],
  ];
  for (const [option, state] of expected) {
    if (wire[option] !== state) {
      fail(`packaged Electron fuse ${FuseV1Options[option]} is not fail-closed`);
    }
  }
  return wire;
}

function verifyPackagedPdfRuntime(appPath, listAsar = listPackage) {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  if (!fs.existsSync(asarPath)) fail('packaged app.asar is missing');

  let entries;
  try {
    entries = listAsar(asarPath).map(entry =>
      String(entry).replace(/\\/g, '/').replace(/^\/+/, ''));
  } catch (error) {
    fail(`could not inspect packaged app.asar: ${error.message}`);
  }
  const entrySet = new Set(entries);
  const requiredEntries = [
    'main.js',
    'preload.js',
    'pdf-worker.js',
    'node_modules/pdf-parse/package.json',
    'node_modules/@napi-rs/canvas/package.json',
    'node_modules/@napi-rs/canvas-darwin-arm64/package.json',
  ];
  for (const entry of requiredEntries) {
    if (!entrySet.has(entry)) fail(`packaged app.asar is missing ${entry}`);
  }

  const nativeCanvasPath = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@napi-rs',
    'canvas-darwin-arm64',
    'skia.darwin-arm64.node',
  );
  if (
    !fs.existsSync(nativeCanvasPath) ||
    !fs.statSync(nativeCanvasPath).isFile() ||
    fs.statSync(nativeCanvasPath).size < 1
  ) {
    fail('packaged arm64 native canvas binary is missing from app.asar.unpacked');
  }
}

function verifyPackagedFirstPartyContent(
  appPath,
  sourceManifest,
  extractAsarFile = extractFile,
  projectDir = null,
) {
  validateSourceContentManifest(sourceManifest, projectDir);
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const asarPath = path.join(resourcesPath, 'app.asar');

  const verifyContents = (relativePath, contents) => {
    const expected = sourceManifest.files[relativePath];
    if (
      !expected ||
      contents.length !== expected.size ||
      sha256Buffer(contents) !== expected.sha256
    ) {
      fail(`packaged first-party content does not match source: ${relativePath}`);
    }
  };

  for (const relativePath of FIRST_PARTY_ASAR_FILES) {
    let contents;
    try {
      contents = extractAsarFile(asarPath, relativePath, false);
    } catch (error) {
      fail(`could not extract first-party app.asar content ${relativePath}: ${error.message}`);
    }
    verifyContents(relativePath, Buffer.from(contents));
  }

  for (const relativePath of FIRST_PARTY_RESOURCE_FILES) {
    verifyContents(
      relativePath,
      readRegularFile(
        path.join(resourcesPath, ...relativePath.split('/')),
        `packaged first-party content ${relativePath}`,
      ),
    );
  }

  const packagedVendorDir = path.join(resourcesPath, 'vendor');
  const packagedVendorFiles = listRegularRelativeFiles(packagedVendorDir)
    .map(relativePath => path.posix.join('vendor', relativePath))
    .sort();
  const expectedVendorFiles = sortedObjectKeys(sourceManifest.files)
    .filter(relativePath => relativePath.startsWith('vendor/'));
  if (!sameStringList(packagedVendorFiles, expectedVendorFiles)) {
    fail('packaged vendor content does not match the source-content manifest file set');
  }
  for (const relativePath of packagedVendorFiles) {
    verifyContents(
      relativePath,
      readRegularFile(
        path.join(resourcesPath, ...relativePath.split('/')),
        `packaged first-party content ${relativePath}`,
      ),
    );
  }
  return sourceManifest;
}

function verifyPackagedUpdaterConfig(appPath, packageMetadata) {
  const configPath = path.join(appPath, 'Contents', 'Resources', 'app-update.yml');
  let stat;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    fail(`packaged app-update.yml is missing: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) {
    fail('packaged app-update.yml must be a bounded regular file');
  }

  let config;
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`packaged app-update.yml is invalid YAML: ${error.message}`);
  }
  const publish = packageMetadata.build?.publish;
  if (
    !hasExactKeys(publish, EXACT_PUBLISH_KEYS) ||
    publish.provider !== 'github' ||
    publish?.owner !== EXPECTED_UPDATE_OWNER ||
    publish?.repo !== EXPECTED_UPDATE_REPO ||
    publish.releaseType !== 'release' ||
    !hasExactKeys(config, EXACT_PACKAGED_UPDATE_KEYS) ||
    config.provider !== 'github' ||
    config.owner !== EXPECTED_UPDATE_OWNER ||
    config.repo !== EXPECTED_UPDATE_REPO ||
    config.releaseType !== 'release' ||
    config.updaterCacheDirName !== EXPECTED_UPDATER_CACHE_DIR_NAME
  ) {
    fail(
      'package publish settings and packaged app-update.yml must use the exact ' +
      'public GitHub release schema, owner, repo, release type, and updater cache ' +
      EXPECTED_UPDATER_CACHE_DIR_NAME,
    );
  }
  return config;
}

function verifySignedCodePolicy(
  codePath,
  expectedTeamId,
  execute = run,
  requiredEntitlements = REQUIRED_ENTITLEMENTS,
) {
  execute(CODESIGN, ['--verify', '--deep', '--strict', '--verbose=4', codePath]);
  const signatureDetails = execute(CODESIGN, ['-dv', '--verbose=4', codePath]);
  const teamMatch = signatureDetails.match(/TeamIdentifier=([A-Z0-9]{10})/);
  if (!teamMatch || teamMatch[1] !== expectedTeamId) {
    fail(`signed code team does not match APPLE_TEAM_ID ${expectedTeamId}: ${codePath}`);
  }
  if (!/\bflags=.*\bruntime\b/i.test(signatureDetails)) {
    fail(`signed code is missing hardened-runtime signing: ${codePath}`);
  }

  const entitlements = execute(CODESIGN, ['-d', '--entitlements', '-', codePath]);
  for (const key of requiredEntitlements) {
    if (entitlementBoolean(entitlements, key) !== true) {
      fail(`signed code is missing required entitlement ${key}: ${codePath}`);
    }
  }
  for (const key of FORBIDDEN_ENTITLEMENTS) {
    if (entitlementBoolean(entitlements, key) !== null) {
      fail(`signed code contains forbidden entitlement ${key}: ${codePath}`);
    }
  }
}

function verifyNestedHelperPolicies(appPath, expectedTeamId, execute = run) {
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks');
  const expectedNames = [
    `${PRODUCT_NAME} Helper.app`,
    `${PRODUCT_NAME} Helper (GPU).app`,
    `${PRODUCT_NAME} Helper (Plugin).app`,
    `${PRODUCT_NAME} Helper (Renderer).app`,
  ].sort();
  let actualNames;
  try {
    actualNames = fs.readdirSync(frameworksPath, { withFileTypes: true })
      .filter(entry => entry.name.endsWith('.app'))
      .map(entry => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          fail(`nested helper must be a real app directory: ${entry.name}`);
        }
        return entry.name;
      })
      .sort();
  } catch (error) {
    if (String(error.message).startsWith('Release verification failed:')) throw error;
    fail(`could not enumerate nested helper apps: ${error.message}`);
  }
  if (!sameStringList(actualNames, expectedNames)) {
    fail('packaged app does not contain the exact expected Electron helper app set');
  }
  for (const name of actualNames) {
    verifySignedCodePolicy(
      path.join(frameworksPath, name),
      expectedTeamId,
      execute,
      REQUIRED_ENTITLEMENTS,
    );
  }
}

async function verifyExtractedApp(
  appPath,
  packageMetadata,
  expectedTeamId,
  execute = run,
  readFuseWire = getCurrentFuseWire,
  sourceManifest = null,
) {
  verifySignedCodePolicy(appPath, expectedTeamId, execute);
  execute(SPCTL, ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  execute(XCRUN, ['stapler', 'validate', appPath]);

  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const readPlist = key => execute(
    PLUTIL,
    ['-extract', key, 'raw', '-o', '-', plistPath],
  ).trim();
  if (readPlist('CFBundleIdentifier') !== packageMetadata.build.appId) {
    fail('updater ZIP bundle identifier does not match package.json');
  }
  if (
    readPlist('CFBundleShortVersionString') !== packageMetadata.version ||
    readPlist('CFBundleVersion') !== packageMetadata.version
  ) {
    fail('updater ZIP application version does not match package.json');
  }

  const executable = path.join(appPath, 'Contents', 'MacOS', PRODUCT_NAME);
  const architectures = execute(LIPO, ['-archs', executable]).trim();
  if (architectures !== RELEASE_ARCH) {
    fail(`updater ZIP executable architecture must be arm64, found: ${architectures}`);
  }
  verifyPackagedUpdaterConfig(appPath, packageMetadata);
  verifyPackagedPdfRuntime(appPath);
  if (!sourceManifest) fail('source-content manifest is required for packaged app verification');
  verifyPackagedFirstPartyContent(appPath, sourceManifest);
  verifyNestedHelperPolicies(appPath, expectedTeamId, execute);
  await verifyElectronFuses(appPath, readFuseWire);
}

async function verifyDmgContents(
  dmgPath,
  packageMetadata,
  expectedTeamId,
  execute = run,
  verifyApp = verifyExtractedApp,
  sourceManifest = null,
) {
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-release-dmg-'));
  let attachAttempted = false;
  let validationError = null;
  try {
    attachAttempted = true;
    execute(HDIUTIL, [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountRoot,
      dmgPath,
    ]);
    const mountedApps = fs.readdirSync(mountRoot, { withFileTypes: true })
      .filter(entry => entry.name.endsWith('.app'))
      .map(entry => entry.name);
    if (
      mountedApps.length !== 1 ||
      mountedApps[0] !== `${PRODUCT_NAME}.app`
    ) {
      fail(`mounted DMG must contain exactly one top-level ${PRODUCT_NAME}.app`);
    }
    const appPath = path.join(mountRoot, `${PRODUCT_NAME}.app`);
    let appStat;
    try {
      appStat = fs.lstatSync(appPath);
    } catch (error) {
      fail(`mounted DMG is missing ${PRODUCT_NAME}.app: ${error.message}`);
    }
    if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
      fail(`mounted DMG ${PRODUCT_NAME}.app must be a real app directory`);
    }
    await verifyApp(
      appPath,
      packageMetadata,
      expectedTeamId,
      execute,
      getCurrentFuseWire,
      sourceManifest,
    );
  } catch (error) {
    validationError = error;
  } finally {
    if (attachAttempted) {
      try {
        execute(HDIUTIL, ['detach', mountRoot]);
      } catch (detachError) {
        validationError = validationError
          ? new Error(`${validationError.message}; DMG detach also failed: ${detachError.message}`, {
            cause: validationError,
          })
          : detachError;
      }
    }
    try {
      fs.rmdirSync(mountRoot);
    } catch (cleanupError) {
      if (!validationError) validationError = cleanupError;
    }
  }
  if (validationError) throw validationError;
}

async function verifyUpdaterZip(
  outDir,
  feed,
  packageMetadata = loadPackage(),
  expectedTeamId = requireTeamId(),
  execute = run,
  sourceManifest = null,
) {
  const zipPath = path.join(outDir, feed.path);
  validateZipEntries(execute(UNZIP, ['-Z1', zipPath]));
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-updater-zip-'));
  try {
    execute(DITTO, ['-x', '-k', zipPath, extractDir]);
    const appPath = path.join(extractDir, `${PRODUCT_NAME}.app`);
    if (!fs.existsSync(appPath)) fail('updater ZIP did not extract the expected app bundle');
    await verifyExtractedApp(
      appPath,
      packageMetadata,
      expectedTeamId,
      execute,
      getCurrentFuseWire,
      sourceManifest,
    );
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function validateProvenanceContext(packageMetadata, env = process.env) {
  const commit = env.MUSIC_BOX_SOURCE_COMMIT;
  const tree = env.MUSIC_BOX_SOURCE_TREE;
  const version = env.MUSIC_BOX_RELEASE_VERSION;
  const teamId = requireTeamId(env);
  const objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
  if (!objectIdPattern.test(commit || '') || !objectIdPattern.test(tree || '')) {
    fail('source commit and tree provenance are required');
  }
  if (version !== packageMetadata.version) {
    fail('release version provenance does not match package.json');
  }
  return { commit, tree, version, teamId };
}

function verifySourceCheckout(packageMetadata, env = process.env, execute = run) {
  const context = validateProvenanceContext(packageMetadata, env);
  if (execute('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_DIR }).trim() !== context.commit) {
    fail('Git HEAD changed after the release provenance was recorded');
  }
  if (
    execute('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_DIR }).trim() !== context.tree
  ) {
    fail('Git source tree changed after the release provenance was recorded');
  }
  if (execute('git', ['diff', '--cached', '--name-only'], { cwd: PROJECT_DIR }).trim()) {
    fail('Git index changed during the release');
  }
  const changed = execute('git', ['diff', '--name-only'], { cwd: PROJECT_DIR })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  // Two shapes are legitimate here. A version bump rewrites exactly the two
  // controlled files. A release of a version that is ALREADY committed — the
  // provenance-correct path, where the source commit genuinely contains the
  // version being shipped — rewrites nothing at all, so the checkout is
  // byte-identical to the commit. Requiring the bump made that path
  // unreleasable: it failed here after signing, notarizing and stapling had all
  // succeeded. An empty diff is the stronger guarantee, not a weaker one.
  const changedList = changed.join('\n');
  if (changedList !== 'package-lock.json\npackage.json' && changedList !== '') {
    fail(
      'release checkout contains changes beyond the controlled version files: ' +
      changedList.split('\n').join(', '),
    );
  }
  if (
    execute('git', ['ls-files', '--others', '--exclude-standard'], { cwd: PROJECT_DIR }).trim()
  ) {
    fail('release checkout contains untracked files');
  }
  return context;
}

async function writeProvenance(
  outDir,
  packageMetadata,
  context,
  sourceContent,
) {
  verifySourceContentManifest(sourceContent);
  const names = expectedArtifactNames(packageMetadata.version);
  const assetNames = [names.zip, names.zipBlockmap, names.dmg, 'latest-mac.yml'];
  const assets = {};
  for (const name of assetNames) {
    const filePath = path.join(outDir, name);
    if (!fs.existsSync(filePath)) fail(`cannot record missing provenance asset ${name}`);
    assets[name] = {
      size: fs.statSync(filePath).size,
      sha256: await sha256(filePath),
    };
  }
  const provenance = {
    schemaVersion: 2,
    product: PRODUCT_NAME,
    version: packageMetadata.version,
    architecture: RELEASE_ARCH,
    bundleId: packageMetadata.build.appId,
    appleTeamId: context.teamId,
    sourceCommit: context.commit,
    sourceTree: context.tree,
    sourceContent,
    assets,
  };
  atomicWrite(
    path.join(outDir, PROVENANCE_FILE),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

async function verifyProvenance(outDir, packageMetadata = loadPackage(), env = null) {
  const provenancePath = path.join(outDir, PROVENANCE_FILE);
  if (!fs.existsSync(provenancePath)) fail(`missing ${PROVENANCE_FILE}`);
  let provenance;
  try {
    provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  } catch (error) {
    fail(`${PROVENANCE_FILE} is invalid JSON: ${error.message}`);
  }
  if (
    provenance.schemaVersion !== 2 ||
    provenance.product !== PRODUCT_NAME ||
    provenance.version !== packageMetadata.version ||
    provenance.architecture !== RELEASE_ARCH ||
    provenance.bundleId !== packageMetadata.build.appId ||
    !/^[A-Z0-9]{10}$/.test(provenance.appleTeamId || '') ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(provenance.sourceCommit || '') ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(provenance.sourceTree || '')
  ) {
    fail(`${PROVENANCE_FILE} metadata is incomplete or inconsistent`);
  }
  validateSourceContentManifest(provenance.sourceContent);
  if (env) {
    verifySourceContentManifest(provenance.sourceContent);
    const context = validateProvenanceContext(packageMetadata, env);
    if (
      provenance.sourceCommit !== context.commit ||
      provenance.sourceTree !== context.tree ||
      provenance.appleTeamId !== context.teamId
    ) {
      fail(`${PROVENANCE_FILE} does not match the active release context`);
    }
  }

  const names = expectedArtifactNames(packageMetadata.version);
  const expectedNames = [names.zip, names.zipBlockmap, names.dmg, 'latest-mac.yml'];
  if (
    !sameStringList(
      Object.keys(provenance.assets || {}).sort(),
      expectedNames.sort(),
    )
  ) {
    fail(`${PROVENANCE_FILE} has an unexpected asset set`);
  }
  for (const name of expectedNames) {
    const filePath = path.join(outDir, name);
    const record = provenance.assets[name];
    if (
      !record ||
      record.size !== fs.statSync(filePath).size ||
      record.sha256 !== await sha256(filePath)
    ) {
      fail(`${PROVENANCE_FILE} digest mismatch for ${name}`);
    }
  }
  return provenance;
}

async function finalizeAndVerifyRelease(outDir, packageMetadata = loadPackage()) {
  const context = verifySourceCheckout(packageMetadata);
  const sourceContent = loadSourceContentManifest();
  await finalizeUpdaterFeed(outDir, packageMetadata);
  const feed = await verifyFeedArtifacts(outDir, packageMetadata);
  const names = expectedArtifactNames(packageMetadata.version);
  const dmgPath = path.join(outDir, names.dmg);
  verifyMacDistribution(outDir, [dmgPath]);
  await verifyUpdaterZip(
    outDir,
    feed,
    packageMetadata,
    context.teamId,
    run,
    sourceContent,
  );
  await verifyDmgContents(
    dmgPath,
    packageMetadata,
    context.teamId,
    run,
    verifyExtractedApp,
    sourceContent,
  );
  await writeProvenance(outDir, packageMetadata, context, sourceContent);
  await verifyProvenance(outDir, packageMetadata, process.env);
  return feed;
}

async function verifyCompletedRelease(outDir, packageMetadata = loadPackage()) {
  const provenance = await verifyProvenance(outDir, packageMetadata);
  const feed = await verifyFeedArtifacts(outDir, packageMetadata);
  const names = expectedArtifactNames(packageMetadata.version);
  const dmgPath = path.join(outDir, names.dmg);
  verifyMacDistribution(outDir, [dmgPath]);
  await verifyUpdaterZip(
    outDir,
    feed,
    packageMetadata,
    provenance.appleTeamId,
    run,
    provenance.sourceContent,
  );
  await verifyDmgContents(
    dmgPath,
    packageMetadata,
    provenance.appleTeamId,
    run,
    verifyExtractedApp,
    provenance.sourceContent,
  );
  return { feed, provenance };
}

async function releaseArtifactGate(buildResult) {
  const artifactPaths = buildResult.artifactPaths || [];
  const distributionArtifacts = artifactPaths.filter(filePath =>
    /\.(?:dmg|zip)$/.test(filePath),
  );
  console.log(
    `Release artifact gate invoked by electron-builder; ` +
    `${distributionArtifacts.length} distribution artifact(s) to verify.`,
  );
  if (distributionArtifacts.length === 0) return [];
  if (process.env.MUSIC_BOX_RELEASE_VERIFY !== '1') {
    fail('distribution builds must set MUSIC_BOX_RELEASE_VERIFY=1');
  }

  const expectedTeamId = requireTeamId();
  const sourceContent = loadSourceContentManifest();
  const verifiedArtifacts = verifyBuildArtifacts(
    buildResult.outDir,
    artifactPaths,
    loadPackage(),
  );
  const dmgPaths = verifiedArtifacts.filter(filePath => filePath.endsWith('.dmg'));
  if (dmgPaths.length !== 1) fail(`expected exactly one DMG, found ${dmgPaths.length}`);
  await notarizeAndStapleDmg(dmgPaths[0]);
  verifyMacDistribution(buildResult.outDir, dmgPaths);
  await verifyDmgContents(
    dmgPaths[0],
    loadPackage(),
    expectedTeamId,
    run,
    verifyExtractedApp,
    sourceContent,
  );

  console.log('Signed, notarized, and mounted-DMG build artifacts passed the pre-feed gate.');
  return [];
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--write-source-manifest') {
    try {
      writeSourceContentManifest(path.resolve(args[1] || ''));
      console.log(`Wrote pre-build source-content manifest to ${path.resolve(args[1])}.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    const finalize = args.includes('--finalize');
    const outDirArg = args.find(arg => arg !== '--finalize');
    const outDir = path.resolve(outDirArg || path.join(PROJECT_DIR, 'dist'));
    const operation = finalize
      ? finalizeAndVerifyRelease(outDir)
      : verifyCompletedRelease(outDir);
    operation
      .then(() => {
        console.log(
          'Updater ZIP, real blockmap, source-content provenance, signing identity, ' +
          'hardened runtime, entitlements, notarization tickets, DMG, and Gatekeeper ' +
          'checks passed.',
        );
      })
      .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}

exports.default = releaseArtifactGate;
exports.PROVENANCE_FILE = PROVENANCE_FILE;
exports.EXPECTED_UPDATER_CACHE_DIR_NAME = EXPECTED_UPDATER_CACHE_DIR_NAME;
exports.createSourceContentManifest = createSourceContentManifest;
exports.expectedArtifactNames = expectedArtifactNames;
exports.expectedBaseName = expectedBaseName;
exports.entitlementBoolean = entitlementBoolean;
exports.finalizeAndVerifyRelease = finalizeAndVerifyRelease;
exports.finalizeUpdaterFeed = finalizeUpdaterFeed;
exports.getNotarizeOptions = getNotarizeOptions;
exports.parseBlockmap = parseBlockmap;
exports.plistBoolean = plistBoolean;
exports.requireTeamId = requireTeamId;
exports.validateProvenanceContext = validateProvenanceContext;
exports.validateZipEntries = validateZipEntries;
exports.verifyBlockmapCorrespondence = verifyBlockmapCorrespondence;
exports.verifyBuildArtifacts = verifyBuildArtifacts;
exports.verifyCompletedRelease = verifyCompletedRelease;
exports.verifyDmgContents = verifyDmgContents;
exports.verifyElectronFuses = verifyElectronFuses;
exports.verifyExtractedApp = verifyExtractedApp;
exports.verifyFeedArtifacts = verifyFeedArtifacts;
exports.verifyMacDistribution = verifyMacDistribution;
exports.verifyNestedHelperPolicies = verifyNestedHelperPolicies;
exports.verifyPackagedPdfRuntime = verifyPackagedPdfRuntime;
exports.verifyPackagedFirstPartyContent = verifyPackagedFirstPartyContent;
exports.verifyPackagedUpdaterConfig = verifyPackagedUpdaterConfig;
exports.verifyProvenance = verifyProvenance;
exports.verifySourceContentManifest = verifySourceContentManifest;
exports.verifySignedCodePolicy = verifySignedCodePolicy;
exports.verifySourceCheckout = verifySourceCheckout;
exports.verifyUpdaterZip = verifyUpdaterZip;
exports.writeSourceContentManifest = writeSourceContentManifest;
exports.writeProvenance = writeProvenance;
