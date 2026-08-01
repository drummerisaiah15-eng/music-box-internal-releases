'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  PROVENANCE_FILE,
  expectedArtifactNames,
  verifyCompletedRelease,
  verifyProvenance,
  verifySourceCheckout,
} = require('./release-artifact-gate');

const PROJECT_DIR = path.resolve(__dirname, '..');
const GITHUB_API_VERSION = '2026-03-10';
const API_TIMEOUT_MS = 60_000;
const ASSET_UPLOAD_TIMEOUT_MS = 30 * 60_000;
const API_HOST = 'api.github.com';
const UPLOAD_HOST = 'uploads.github.com';
const DOWNLOAD_HOST = 'github.com';
const DOWNLOAD_REDIRECT_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const PUBLICATION_STATE_FILE = '.publication-state';
const MAX_PUBLIC_FEED_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(`Verified release publication failed: ${message}`);
}

function loadPackage() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
}

function parseStrictVersion(version, label = 'version') {
  const match = String(version).match(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
  );
  if (!match) fail(`${label} is not strict stable semver: ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseStrictVersion(left, 'candidate version');
  const b = parseStrictVersion(right, 'existing version');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateRepoPart(value, label) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value || '')) fail(`invalid GitHub ${label}`);
  return value;
}

function assertHttpsHost(rawUrl, expectedHost, expectedPathPrefix = '/') {
  let url;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
  } catch {
    fail(`invalid GitHub URL: ${rawUrl}`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(expectedPathPrefix)
  ) {
    fail(`refusing unexpected GitHub endpoint: ${url.href}`);
  }
  return url;
}

function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'music-box-internal-release',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...extra,
  };
}

function publicGithubHeaders(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'music-box-internal-release-verifier',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...extra,
  };
}

async function responseJson(response, method, url, expectedStatuses) {
  const responseUrl = response.url || String(url);
  assertHttpsHost(responseUrl, new URL(String(url)).hostname);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!expectedStatuses.includes(response.status)) {
    const detail = typeof body === 'object' && body?.message
      ? body.message
      : String(body || response.statusText || 'unknown error');
    fail(`${method} ${new URL(String(url)).pathname} returned ${response.status}: ${detail}`);
  }
  return body;
}

async function githubJson(
  fetchImpl,
  token,
  rawUrl,
  options = {},
  expectedStatuses = [200],
) {
  const url = assertHttpsHost(rawUrl, API_HOST, '/repos/');
  const method = options.method || 'GET';
  const response = await fetchImpl(url, {
    ...options,
    method,
    headers: githubHeaders(token, options.headers),
    redirect: 'error',
    signal: options.signal || AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return {
    body: await responseJson(response, method, url, expectedStatuses),
    status: response.status,
  };
}

async function githubPublicJson(fetchImpl, rawUrl, expectedStatuses = [200]) {
  const url = assertHttpsHost(rawUrl, API_HOST, '/repos/');
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: publicGithubHeaders(),
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return {
    body: await responseJson(response, 'GET', url, expectedStatuses),
    status: response.status,
  };
}

function publicationStatePath(outDir, stateFile = process.env.MUSIC_BOX_PUBLICATION_STATE_FILE) {
  const expected = path.join(path.resolve(outDir), PUBLICATION_STATE_FILE);
  const resolved = path.resolve(stateFile || expected);
  if (resolved !== expected) fail('publication state file must stay inside the release staging directory');
  return resolved;
}

function writePublicationState(outDir, state, stateFile) {
  const allowed = new Set([
    'not-started',
    'creating',
    'draft',
    'publishing',
    'published',
    'unknown',
  ]);
  if (!allowed.has(state)) fail(`invalid publication state ${state}`);
  const filePath = publicationStatePath(outDir, stateFile);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${state}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function expectedReleaseAssets(outDir, feed, packageMetadata = loadPackage()) {
  const names = expectedArtifactNames(packageMetadata.version);
  if (feed?.path !== names.zip || feed?.files?.length !== 1) {
    fail('verified updater feed is not ZIP-only');
  }
  const assetNames = [
    names.zip,
    names.zipBlockmap,
    names.dmg,
    'latest-mac.yml',
    PROVENANCE_FILE,
  ];
  return assetNames.map(name => {
    const filePath = path.join(outDir, name);
    if (!fs.existsSync(filePath)) fail(`missing release asset ${name}`);
    return { name, filePath };
  });
}

function statIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  if (!stat.isFile()) fail(`release asset is not a regular file: ${path.basename(filePath)}`);
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
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

function sha256(filePath) {
  return fileDigest(filePath, 'sha256', 'hex');
}

function sha512(filePath) {
  return fileDigest(filePath, 'sha512', 'base64');
}

async function snapshotReleaseAssets(assets) {
  const snapshots = [];
  for (const asset of assets) {
    const identity = statIdentity(asset.filePath);
    snapshots.push({
      ...asset,
      ...identity,
      sizeNumber: Number(identity.size),
      sha256: await sha256(asset.filePath),
      sha512: await sha512(asset.filePath),
    });
  }
  return snapshots;
}

async function assertAssetUnchanged(asset) {
  const current = statIdentity(asset.filePath);
  for (const field of ['device', 'inode', 'size', 'mtimeNs']) {
    if (current[field] !== asset[field]) {
      fail(`${asset.name} changed after local verification`);
    }
  }
  if (await sha256(asset.filePath) !== asset.sha256) {
    fail(`${asset.name} digest changed after local verification`);
  }
}

async function assertAllAssetsUnchanged(assets) {
  for (const asset of assets) await assertAssetUnchanged(asset);
}

function contentType(name) {
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.yml')) return 'application/x-yaml';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function validateUploadUrl(rawUploadUrl, owner, repo, releaseId) {
  const withoutTemplate = String(rawUploadUrl).replace(/\{\?name,label\}$/, '');
  const expectedPath = `/repos/${owner}/${repo}/releases/${releaseId}/assets`;
  const url = assertHttpsHost(withoutTemplate, UPLOAD_HOST, expectedPath);
  if (url.pathname !== expectedPath || url.search || url.hash) {
    fail(`unexpected GitHub upload URL: ${url.href}`);
  }
  return url;
}

async function uploadAsset(fetchImpl, token, uploadUrl, asset, owner, repo, releaseId) {
  await assertAssetUnchanged(asset);
  const url = validateUploadUrl(uploadUrl, owner, repo, releaseId);
  url.searchParams.set('name', asset.name);
  const stream = fs.createReadStream(asset.filePath);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: githubHeaders(token, {
      'Content-Length': String(asset.sizeNumber),
      'Content-Type': contentType(asset.name),
    }),
    body: stream,
    duplex: 'half',
    redirect: 'error',
    signal: AbortSignal.timeout(ASSET_UPLOAD_TIMEOUT_MS),
  });
  const uploaded = await responseJson(response, 'POST', url, [201]);
  const expectedDigest = `sha256:${asset.sha256}`;
  if (
    !uploaded ||
    uploaded.name !== asset.name ||
    uploaded.size !== asset.sizeNumber ||
    uploaded.state !== 'uploaded' ||
    uploaded.digest !== expectedDigest
  ) {
    fail(`GitHub did not confirm name, size, state, and SHA-256 for ${asset.name}`);
  }
  return uploaded;
}

async function confirmRemoteAssets(
  fetchImpl,
  token,
  apiBase,
  releaseId,
  assets,
) {
  const { body: remote } = await githubJson(
    fetchImpl,
    token,
    `${apiBase}/releases/${releaseId}/assets?per_page=100`,
  );
  if (!Array.isArray(remote)) fail('GitHub release asset response was not an array');
  if (remote.length !== assets.length) {
    fail(`release contains ${remote.length} assets; expected ${assets.length}`);
  }
  const byName = new Map(remote.map(asset => [asset.name, asset]));
  if (byName.size !== remote.length) fail('GitHub release contains duplicate asset names');

  for (const asset of assets) {
    const uploaded = byName.get(asset.name);
    if (
      !uploaded ||
      uploaded.state !== 'uploaded' ||
      uploaded.size !== asset.sizeNumber ||
      uploaded.digest !== `sha256:${asset.sha256}`
    ) {
      fail(`remote SHA-256 verification failed for ${asset.name}`);
    }
  }
}

function githubConfig(packageMetadata = loadPackage()) {
  const publish = packageMetadata.build?.publish;
  if (publish?.provider !== 'github') fail('package.json publish provider must be GitHub');
  return {
    owner: validateRepoPart(publish.owner, 'owner'),
    repo: validateRepoPart(publish.repo, 'repo'),
  };
}

async function getReleaseByTag(fetchImpl, token, apiBase, tag) {
  const { body, status } = await githubJson(
    fetchImpl,
    token,
    `${apiBase}/releases/tags/${encodeURIComponent(tag)}`,
    {},
    [200, 404],
  );
  return status === 404 ? null : body;
}

async function assertPublicRepository(fetchImpl, token, owner, repo) {
  const apiBase = `https://${API_HOST}/repos/${owner}/${repo}`;
  const { body } = await githubJson(fetchImpl, token, apiBase);
  const expectedFullName = `${owner}/${repo}`.toLowerCase();
  if (
    !body ||
    String(body.full_name || '').toLowerCase() !== expectedFullName ||
    body.private !== false ||
    body.visibility !== 'public' ||
    body.archived === true ||
    body.disabled === true
  ) {
    fail(`GitHub repository ${owner}/${repo} must be the active public update repository`);
  }
  return body;
}

async function getStablePublishedVersions(fetchImpl, token, owner, repo) {
  const apiBase = `https://${API_HOST}/repos/${owner}/${repo}`;
  const versions = new Set();
  const nonStableReleaseTags = new Set();
  for (let page = 1; ; page += 1) {
    const { body } = await githubJson(
      fetchImpl,
      token,
      `${apiBase}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(body)) fail('GitHub releases response was not an array');
    for (const release of body) {
      if (release?.draft === true || release?.prerelease === true) {
        if (typeof release?.tag_name === 'string') {
          nonStableReleaseTags.add(release.tag_name);
        }
        continue;
      }
      const match = String(release?.tag_name || '').match(/^v(.+)$/);
      if (!match) {
        fail(`stable GitHub release tag is not v-prefixed semver: ${release?.tag_name}`);
      }
      parseStrictVersion(match[1], 'stable GitHub release version');
      versions.add(match[1]);
    }
    if (body.length < 100) break;
    if (page >= 1000) fail('GitHub release pagination exceeded the safety limit');
  }

  for (let page = 1; ; page += 1) {
    const { body } = await githubJson(
      fetchImpl,
      token,
      `${apiBase}/tags?per_page=100&page=${page}`,
    );
    if (!Array.isArray(body)) fail('GitHub tags response was not an array');
    for (const tag of body) {
      if (nonStableReleaseTags.has(tag?.name)) continue;
      const match = String(tag?.name || '').match(
        /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
      );
      if (match) versions.add(match.slice(1).join('.'));
    }
    if (body.length < 100) break;
    if (page >= 1000) fail('GitHub tag pagination exceeded the safety limit');
  }
  return [...versions];
}

async function getLatestPublishedVersion(fetchImpl, token, owner, repo) {
  const versions = await getStablePublishedVersions(fetchImpl, token, owner, repo);
  return versions.reduce(
    (latest, version) => (
      latest === null || compareVersions(version, latest) > 0 ? version : latest
    ),
    null,
  );
}

async function assertVersionIsNewerThanGitHub({
  version,
  owner,
  repo,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) fail('GH_TOKEN is required');
  parseStrictVersion(version, 'candidate version');
  await assertPublicRepository(fetchImpl, token, owner, repo);
  const latest = await getLatestPublishedVersion(fetchImpl, token, owner, repo);
  if (latest && compareVersions(version, latest) <= 0) {
    fail(`candidate ${version} must be greater than GitHub latest ${latest}`);
  }
  return latest;
}

async function assertPublishedVersionIsStrictMaximum({
  version,
  owner,
  repo,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) fail('GH_TOKEN is required');
  parseStrictVersion(version, 'published candidate version');
  await assertPublicRepository(fetchImpl, token, owner, repo);
  const maximum = await getLatestPublishedVersion(fetchImpl, token, owner, repo);
  if (maximum !== version) {
    fail(
      `published candidate ${version} is not the strict maximum stable GitHub ` +
      `version${maximum ? `; maximum is ${maximum}` : ''}`,
    );
  }
  return maximum;
}

function validateReleaseObject(release, tag, expectedId = null) {
  if (
    !release ||
    !Number.isInteger(release.id) ||
    release.id < 1 ||
    release.tag_name !== tag ||
    (expectedId !== null && release.id !== expectedId)
  ) {
    fail(`GitHub returned an inconsistent release object for ${tag}`);
  }
  return release;
}

function canonicalDownloadUrl(owner, repo, tag, name) {
  const ownerPart = encodeURIComponent(validateRepoPart(owner, 'owner'));
  const repoPart = encodeURIComponent(validateRepoPart(repo, 'repo'));
  const tagPart = encodeURIComponent(tag);
  const namePart = encodeURIComponent(name);
  return `https://${DOWNLOAD_HOST}/${ownerPart}/${repoPart}/releases/download/` +
    `${tagPart}/${namePart}`;
}

function canonicalLatestDownloadUrl(owner, repo, name) {
  const ownerPart = encodeURIComponent(validateRepoPart(owner, 'owner'));
  const repoPart = encodeURIComponent(validateRepoPart(repo, 'repo'));
  const namePart = encodeURIComponent(name);
  return `https://${DOWNLOAD_HOST}/${ownerPart}/${repoPart}/releases/latest/download/` +
    namePart;
}

function assertAnonymousHeaders(headers) {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers || {});
  if (entries.some(([name]) => String(name).toLowerCase() === 'authorization')) {
    fail('anonymous release validation must not send authorization credentials');
  }
}

async function fetchAnonymousDownload(fetchImpl, rawUrl) {
  const initialUrl = assertHttpsHost(rawUrl, DOWNLOAD_HOST, '/');
  const headers = publicGithubHeaders({ Accept: 'application/octet-stream' });
  assertAnonymousHeaders(headers);
  // GitHub release downloads can chain two redirects:
  //   /releases/latest/download/ → /releases/download/vX.Y.Z/ (still github.com)
  //   /releases/download/vX.Y.Z/ → objects.githubusercontent.com (CDN)
  // Both hops must stay on trusted GitHub infrastructure.
  const TRUSTED_HOSTS = new Set([DOWNLOAD_HOST, ...DOWNLOAD_REDIRECT_HOSTS]);

  let url = initialUrl;
  let response;
  for (let hop = 0; hop < 3; hop++) {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(ASSET_UPLOAD_TIMEOUT_MS),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers?.get?.('location');
    if (!location) fail(`anonymous download redirect omitted Location: ${url.pathname}`);
    const next = new URL(location, url);
    if (
      next.protocol !== 'https:' ||
      next.port ||
      next.username ||
      next.password ||
      !TRUSTED_HOSTS.has(next.hostname)
    ) {
      fail(`anonymous download redirected to an untrusted endpoint: ${next.href}`);
    }
    url = next;
  }

  if (response.status !== 200) {
    fail(`anonymous GET ${initialUrl.pathname} returned ${response.status}`);
  }
  if (response.url) {
    const responseUrl = new URL(response.url);
    if (
      responseUrl.protocol !== 'https:' ||
      responseUrl.port ||
      responseUrl.username ||
      responseUrl.password ||
      !TRUSTED_HOSTS.has(responseUrl.hostname)
    ) {
      fail(`anonymous download completed at an untrusted endpoint: ${responseUrl.href}`);
    }
  }
  return response;
}

async function digestResponse(response, captureLimit = 0, expectedSize = null) {
  const sha256Hash = crypto.createHash('sha256');
  const sha512Hash = crypto.createHash('sha512');
  const captured = [];
  let size = 0;
  const consume = chunkValue => {
    const chunk = Buffer.from(chunkValue);
    size += chunk.length;
    if (expectedSize !== null && size > expectedSize) {
      fail('anonymous download exceeded the locally verified size');
    }
    sha256Hash.update(chunk);
    sha512Hash.update(chunk);
    if (captureLimit) {
      if (size > captureLimit) fail('anonymous updater feed exceeded the size limit');
      captured.push(chunk);
    }
  };

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) consume(chunk);
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(value);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    consume(await response.arrayBuffer());
  } else {
    fail('anonymous download response did not expose a readable body');
  }
  return {
    size,
    sha256: sha256Hash.digest('hex'),
    sha512: sha512Hash.digest('base64'),
    contents: captureLimit ? Buffer.concat(captured) : null,
  };
}

function assertDownloadedAsset(downloaded, asset) {
  if (downloaded.size !== asset.sizeNumber || downloaded.sha256 !== asset.sha256) {
    fail(`anonymous download digest mismatch for ${asset.name}`);
  }
}

async function verifyAnonymousPublishedRelease({
  fetchImpl,
  owner,
  repo,
  releaseId,
  version,
  assets,
}) {
  const tag = `v${version}`;
  const apiBase = `https://${API_HOST}/repos/${owner}/${repo}`;
  const { body: latest } = await githubPublicJson(
    fetchImpl,
    `${apiBase}/releases/latest`,
  );
  validateReleaseObject(latest, tag, releaseId);
  if (latest.draft !== false || latest.prerelease !== false) {
    fail(`anonymous GitHub latest does not identify ${tag} as a stable public release`);
  }
  if (!Array.isArray(latest.assets) || latest.assets.length !== assets.length) {
    fail(`anonymous GitHub latest has an unexpected asset count for ${tag}`);
  }

  const publicByName = new Map(latest.assets.map(asset => [asset.name, asset]));
  if (publicByName.size !== latest.assets.length) {
    fail(`anonymous GitHub latest contains duplicate asset names for ${tag}`);
  }
  for (const asset of assets) {
    const publicAsset = publicByName.get(asset.name);
    const expectedUrl = canonicalDownloadUrl(owner, repo, tag, asset.name);
    if (
      !publicAsset ||
      publicAsset.state !== 'uploaded' ||
      publicAsset.size !== asset.sizeNumber ||
      publicAsset.digest !== `sha256:${asset.sha256}` ||
      publicAsset.browser_download_url !== expectedUrl
    ) {
      fail(`anonymous GitHub latest metadata mismatch for ${asset.name}`);
    }
  }

  const names = expectedArtifactNames(version);
  const feedAsset = assets.find(asset => asset.name === 'latest-mac.yml');
  const zipAsset = assets.find(asset => asset.name === names.zip);
  const blockmapAsset = assets.find(asset => asset.name === names.zipBlockmap);
  if (!feedAsset || !zipAsset || !blockmapAsset) {
    fail('anonymous validation is missing the updater feed, ZIP, or named blockmap');
  }

  const feedResponse = await fetchAnonymousDownload(
    fetchImpl,
    canonicalLatestDownloadUrl(owner, repo, feedAsset.name),
  );
  const downloadedFeed = await digestResponse(
    feedResponse,
    MAX_PUBLIC_FEED_BYTES,
    feedAsset.sizeNumber,
  );
  assertDownloadedAsset(downloadedFeed, feedAsset);
  let feed;
  try {
    feed = yaml.load(downloadedFeed.contents.toString('utf8'));
  } catch (error) {
    fail(`anonymous latest-mac.yml is invalid YAML: ${error.message}`);
  }
  if (
    !feed ||
    feed.version !== version ||
    feed.path !== names.zip ||
    feed.sha512 !== zipAsset.sha512 ||
    !Array.isArray(feed.files) ||
    feed.files.length !== 1 ||
    feed.files[0]?.url !== names.zip ||
    feed.files[0]?.size !== zipAsset.sizeNumber ||
    feed.files[0]?.sha512 !== zipAsset.sha512
  ) {
    fail('anonymous latest-mac.yml does not identify the exact verified updater ZIP');
  }

  const zipResponse = await fetchAnonymousDownload(
    fetchImpl,
    publicByName.get(names.zip).browser_download_url,
  );
  const downloadedZip = await digestResponse(zipResponse, 0, zipAsset.sizeNumber);
  assertDownloadedAsset(downloadedZip, zipAsset);
  if (downloadedZip.sha512 !== feed.sha512) {
    fail(`anonymous ZIP SHA-512 does not match latest-mac.yml for ${names.zip}`);
  }

  const blockmapResponse = await fetchAnonymousDownload(
    fetchImpl,
    publicByName.get(names.zipBlockmap).browser_download_url,
  );
  const downloadedBlockmap = await digestResponse(
    blockmapResponse,
    0,
    blockmapAsset.sizeNumber,
  );
  assertDownloadedAsset(downloadedBlockmap, blockmapAsset);
  return latest;
}

async function reconcileRelease(
  fetchImpl,
  token,
  apiBase,
  tag,
  expectedId,
  assets,
) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const release = await getReleaseByTag(fetchImpl, token, apiBase, tag);
      if (!release) return { state: 'unknown', release: null };
      validateReleaseObject(release, tag, expectedId);
      if (release.draft === false) {
        await assertAllAssetsUnchanged(assets);
        await confirmRemoteAssets(fetchImpl, token, apiBase, release.id, assets);
        return { state: 'published', release };
      }
      if (release.draft === true) return { state: 'draft', release };
      return { state: 'unknown', release };
    } catch (error) {
      lastError = error;
    }
  }
  return { state: 'unknown', release: null, error: lastError };
}

async function publishAssetsToDraft({
  outDir,
  feed,
  version,
  owner,
  repo,
  token,
  sourceCommit,
  assets,
  stateFile,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) fail('GH_TOKEN is required');
  if (typeof fetchImpl !== 'function') fail('Node.js fetch support is required');
  owner = validateRepoPart(owner, 'owner');
  repo = validateRepoPart(repo, 'repo');
  parseStrictVersion(version, 'candidate version');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sourceCommit || '')) {
    fail('source commit provenance is required for publication');
  }

  const resolvedStateFile = publicationStatePath(outDir, stateFile);
  writePublicationState(outDir, 'not-started', resolvedStateFile);
  await assertVersionIsNewerThanGitHub({
    version,
    owner,
    repo,
    token,
    fetchImpl,
  });

  const tag = `v${version}`;
  const apiBase = `https://${API_HOST}/repos/${owner}/${repo}`;
  const recordVerifiedPublication = async releaseObject => {
    try {
      const publicRelease = await verifyAnonymousPublishedRelease({
        fetchImpl,
        owner,
        repo,
        releaseId: releaseObject.id,
        version,
        assets,
      });
      await assertPublishedVersionIsStrictMaximum({
        version,
        owner,
        repo,
        token,
        fetchImpl,
      });
      writePublicationState(outDir, 'published', resolvedStateFile);
      return publicRelease;
    } catch (error) {
      writePublicationState(outDir, 'unknown', resolvedStateFile);
      throw new Error(
        `${error.message} The release is public but post-public validation failed.`,
        { cause: error },
      );
    }
  };
  if (await getReleaseByTag(fetchImpl, token, apiBase, tag)) {
    fail(`release tag ${tag} already exists`);
  }

  let release;
  writePublicationState(outDir, 'creating', resolvedStateFile);
  try {
    const { body } = await githubJson(
      fetchImpl,
      token,
      `${apiBase}/releases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: tag,
          // V159-010: without target_commitish GitHub creates the tag at the
          // repository default branch, so every historical tag pointed at the
          // branch head instead of the commit that was actually built. Pin the
          // tag to the exact source commit this artifact came from.
          target_commitish: sourceCommit,
          name: `${PRODUCT_NAME_FOR_RELEASE()} ${version}`,
          body: `Verified arm64 build from source commit ${sourceCommit}.`,
          draft: true,
          prerelease: false,
        }),
      },
      [201],
    );
    release = validateReleaseObject(body, tag);
  } catch (error) {
    const reconciled = await reconcileRelease(
      fetchImpl,
      token,
      apiBase,
      tag,
      null,
      assets,
    );
    if (reconciled.state === 'published') {
      return recordVerifiedPublication(reconciled.release);
    }
    writePublicationState(outDir, reconciled.state, resolvedStateFile);
    if (reconciled.state === 'draft') {
      throw new Error(`${error.message} GitHub confirms ${tag} is still a draft.`, {
        cause: error,
      });
    }
    throw new Error(`${error.message} GitHub release creation outcome is unknown.`, {
      cause: error,
    });
  }

  if (release.draft !== true || !release.upload_url) {
    writePublicationState(outDir, 'unknown', resolvedStateFile);
    fail('GitHub did not create the expected draft release');
  }
  validateUploadUrl(release.upload_url, owner, repo, release.id);
  writePublicationState(outDir, 'draft', resolvedStateFile);

  try {
    for (const asset of assets) {
      console.log(`Uploading verified asset ${asset.name} to draft ${tag}...`);
      await uploadAsset(
        fetchImpl,
        token,
        release.upload_url,
        asset,
        owner,
        repo,
        release.id,
      );
    }
    await assertAllAssetsUnchanged(assets);
    await confirmRemoteAssets(fetchImpl, token, apiBase, release.id, assets);
    await assertVersionIsNewerThanGitHub({
      version,
      owner,
      repo,
      token,
      fetchImpl,
    });
  } catch (error) {
    writePublicationState(outDir, 'draft', resolvedStateFile);
    throw new Error(`${error.message} GitHub confirms ${tag} remains unpublished.`, {
      cause: error,
    });
  }

  writePublicationState(outDir, 'publishing', resolvedStateFile);
  let publishError = null;
  try {
    const { body } = await githubJson(
      fetchImpl,
      token,
      `${apiBase}/releases/${release.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false }),
      },
    );
    const published = validateReleaseObject(body, tag, release.id);
    if (published.draft !== false) fail(`GitHub did not publish ${tag}`);
  } catch (error) {
    publishError = error;
  }

  const reconciled = await reconcileRelease(
    fetchImpl,
    token,
    apiBase,
    tag,
    release.id,
    assets,
  );
  if (reconciled.state === 'published') {
    const publicRelease = await recordVerifiedPublication(reconciled.release);
    console.log(
      `${publishError ? 'Reconciled' : 'Published'} verified GitHub release ${tag}: ` +
      `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
    );
    return publicRelease;
  }
  writePublicationState(outDir, reconciled.state, resolvedStateFile);
  if (reconciled.state === 'draft') {
    throw new Error(
      `${publishError?.message || `GitHub did not publish ${tag}`} ` +
      `GitHub independently confirms ${tag} is a draft.`,
      { cause: publishError || undefined },
    );
  }
  throw new Error(
    `${publishError?.message || `GitHub did not confirm ${tag}`} ` +
    'GitHub publication outcome is unknown.',
    { cause: publishError || undefined },
  );
}

function PRODUCT_NAME_FOR_RELEASE() {
  return 'Music Box Internal';
}

async function verifyAndPublish(
  outDir,
  fetchImpl = globalThis.fetch,
  token = process.env.GH_TOKEN,
) {
  const packageMetadata = loadPackage();
  const { owner, repo } = githubConfig(packageMetadata);
  verifySourceCheckout(packageMetadata, process.env);
  const { feed } = await verifyCompletedRelease(outDir, packageMetadata);
  const provenance = await verifyProvenance(outDir, packageMetadata, process.env);
  const assets = await snapshotReleaseAssets(
    expectedReleaseAssets(outDir, feed, packageMetadata),
  );

  return publishAssetsToDraft({
    outDir,
    feed,
    version: packageMetadata.version,
    owner,
    repo,
    token,
    sourceCommit: provenance.sourceCommit,
    assets,
    stateFile: process.env.MUSIC_BOX_PUBLICATION_STATE_FILE,
    fetchImpl,
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--check-version') {
    const packageMetadata = loadPackage();
    const { owner, repo } = githubConfig(packageMetadata);
    assertVersionIsNewerThanGitHub({
      version: args[1],
      owner,
      repo,
      token: process.env.GH_TOKEN,
    })
      .then(latest => {
        console.log(
          latest
            ? `Candidate ${args[1]} is newer than GitHub latest ${latest}.`
            : `Candidate ${args[1]} is valid; no published GitHub release exists.`,
        );
      })
      .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
  } else {
    const outDir = path.resolve(args[0] || path.join(PROJECT_DIR, 'dist'));
    const token = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    verifyAndPublish(outDir, globalThis.fetch, token).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

exports.assertAllAssetsUnchanged = assertAllAssetsUnchanged;
exports.assertAssetUnchanged = assertAssetUnchanged;
exports.assertHttpsHost = assertHttpsHost;
exports.assertPublishedVersionIsStrictMaximum = assertPublishedVersionIsStrictMaximum;
exports.assertPublicRepository = assertPublicRepository;
exports.assertVersionIsNewerThanGitHub = assertVersionIsNewerThanGitHub;
exports.canonicalDownloadUrl = canonicalDownloadUrl;
exports.canonicalLatestDownloadUrl = canonicalLatestDownloadUrl;
exports.compareVersions = compareVersions;
exports.confirmRemoteAssets = confirmRemoteAssets;
exports.digestResponse = digestResponse;
exports.expectedReleaseAssets = expectedReleaseAssets;
exports.fetchAnonymousDownload = fetchAnonymousDownload;
exports.getLatestPublishedVersion = getLatestPublishedVersion;
exports.getStablePublishedVersions = getStablePublishedVersions;
exports.parseStrictVersion = parseStrictVersion;
exports.publicationStatePath = publicationStatePath;
exports.publishAssetsToDraft = publishAssetsToDraft;
exports.reconcileRelease = reconcileRelease;
exports.snapshotReleaseAssets = snapshotReleaseAssets;
exports.validateUploadUrl = validateUploadUrl;
exports.verifyAndPublish = verifyAndPublish;
exports.verifyAnonymousPublishedRelease = verifyAnonymousPublishedRelease;
exports.writePublicationState = writePublicationState;
