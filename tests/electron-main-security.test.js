const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainPath = path.join(__dirname, '..', 'main.js');
const preloadPath = path.join(__dirname, '..', 'preload.js');
const main = fs.readFileSync(mainPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = braceStart; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function loadFunction(name, context = {}) {
  const sandbox = {
    URL,
    Set,
    ...context,
  };
  vm.runInNewContext(`${extractFunction(main, name)}; this.result = ${name};`, sandbox);
  return sandbox.result;
}

test('Electron entry points parse', () => {
  assert.doesNotThrow(() => new vm.Script(main, { filename: 'main.js' }));
  assert.doesNotThrow(() => new vm.Script(preload, { filename: 'preload.js' }));
});

test('production renderer is sandboxed and has no global DevTools shortcut', () => {
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /devTools:\s*!app\.isPackaged/);
  assert.doesNotMatch(main, /globalShortcut|openDevTools\s*\(/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /\{ urls: \['file:\/\/\*\/\*'\] \}/);
  assert.match(main, /details\.resourceType === 'mainFrame'/);
});

test('every renderer IPC handler passes through the trusted top-frame gate', () => {
  const rawRegistrations = main.match(/ipcMain\.handle\s*\(/g) || [];
  assert.equal(rawRegistrations.length, 1, 'only the secure wrapper directly calls ipcMain.handle');
  assert.match(main, /event\.sender\s*!==\s*mainWindow\.webContents/);
  assert.match(main, /event\.senderFrame\s*!==\s*event\.sender\.mainFrame/);
  assert.match(main, /_isTrustedRendererUrl\(event\.senderFrame\.url\)/);
  for (const channel of [
    'read-text-file',
    'fetch-csv',
    'write-sync-file',
    'print-to-pdf',
    'exchange-ms-code',
    'microsoft-refresh',
    'microsoft-fetch-mail',
    'microsoft-send-mail',
    'firebase-runtime-config',
    'app-session-authenticate-owner',
    'anthropic-message',
    'ringcentral-fetch-data',
    'ringcentral-send-sms',
    'quit-and-install',
  ]) {
    assert.match(main, new RegExp(`_secureHandle\\('${channel.replaceAll('-', '\\-')}'`));
  }
});

test('shell-open URLs use exact query-free destinations and reject exfiltration lookalikes', () => {
  const safeExternalUrl = loadFunction('_safeExternalUrl', {
    EXTERNAL_DESTINATION_ALLOWLIST: new Set([
      'https://console.anthropic.com/',
      'https://developers.ringcentral.com/',
      'https://console.firebase.google.com/',
      'https://clients.mindbodyonline.com/',
    ]),
  });
  assert.equal(safeExternalUrl('https://console.anthropic.com'), true);
  assert.equal(safeExternalUrl('https://clients.mindbodyonline.com/'), true);
  assert.equal(safeExternalUrl('https://console.anthropic.com/?secret=value'), false);
  assert.equal(safeExternalUrl('https://console.anthropic.com/#secret'), false);
  assert.equal(safeExternalUrl('mailto:owner@example.com?subject=Hello'), false);
  assert.equal(safeExternalUrl('https://console.anthropic.com.attacker.example/steal'), false);
  assert.equal(safeExternalUrl('https://attacker.example/?data=secret'), false);
  assert.equal(safeExternalUrl('https://user:pass@console.anthropic.com/'), false);
  assert.equal(safeExternalUrl('https://console.anthropic.com:8443/'), false);
  assert.equal(safeExternalUrl('javascript:alert(1)'), false);
});

test('website and CSV redirect validation is protocol and hostname exact', () => {
  const isAllowedHttpsUrl = loadFunction('_isAllowedHttpsUrl');
  const google = ['google.com', 'googleapis.com', 'googleusercontent.com'];
  assert.equal(isAllowedHttpsUrl('https://docs.google.com/spreadsheets/d/1', google), true);
  assert.equal(isAllowedHttpsUrl('https://google.com.attacker.example/sheet', google), false);
  assert.equal(isAllowedHttpsUrl('https://evilgoogle.com/sheet', google), false);
  assert.equal(isAllowedHttpsUrl('http://docs.google.com/sheet', google), false);
  assert.equal(isAllowedHttpsUrl('https://user@docs.google.com/sheet', google), false);
  assert.equal(isAllowedHttpsUrl('https://www.themusicboxinc.com/about', ['themusicboxinc.com']), true);
  assert.equal(isAllowedHttpsUrl('https://themusicboxinc.com.attacker.example/', ['themusicboxinc.com']), false);
  assert.doesNotMatch(main, /next\.includes\(|loc\.includes\(/);
});

test('OAuth uses a random loopback port, registered localhost root path, and one-time state', () => {
  assert.match(main, /server\.listen\(0,\s*'127\.0\.0\.1'/);
  assert.match(main, /const redirectUri = `http:\/\/localhost:\$\{address\.port\}`/);
  assert.match(main, /String\(req\.headers\.host \|\| ''\)\.toLowerCase\(\) !== pendingOAuth\.expectedHost/);
  assert.match(main, /callback\.origin !== pendingOAuth\.redirectUri/);
  assert.match(main, /callback\.pathname !== '\/'/);
  assert.match(main, /callback\.searchParams\.get\('state'\) !== pendingOAuth\.state/);
  assert.match(main, /pendingOAuth\.callbackReceived/);
  assert.match(main, /crypto\.timingSafeEqual/);
  assert.match(main, /redirect_uri:\s*attempt\.redirectUri/);
  assert.doesNotMatch(main, /localhost:8080|lsof\s+-ti|kill\s+-9|\/ms-token|ms-oauth-token/);
  const errorPage = main.match(/const OAUTH_ERROR_HTML = `([\s\S]*?)`;/);
  assert.ok(errorPage, 'static OAuth error page exists');
  assert.doesNotMatch(errorPage[1], /\$\{/);
});

test('OAuth identifiers and PKCE values have bounded schemas', () => {
  const isUuid = loadFunction('_isUuid');
  const validTenant = loadFunction('_validTenant', { _isUuid: isUuid });
  const validChallenge = loadFunction('_validPkceChallenge');
  assert.equal(validTenant('common'), true);
  assert.equal(validTenant('organizations'), true);
  assert.equal(validTenant('contoso.onmicrosoft.com'), false);
  assert.equal(validTenant('../../attacker'), false);
  assert.equal(isUuid('12345678-1234-4123-8123-123456789abc'), true);
  assert.equal(isUuid('not-a-client-id'), false);
  assert.equal(validChallenge('a'.repeat(43)), true);
  assert.equal(validChallenge('a'.repeat(42)), false);
  assert.equal(validChallenge('a'.repeat(43) + '+'), false);
});

test('Microsoft authorization codes and bearer credentials remain in main', () => {
  assert.match(main, /_safeRendererSend\('ms-auth-code', \{ state: pendingOAuth\.state \}\)/);
  assert.doesNotMatch(main, /_safeRendererSend\('ms-auth-code',\s*\{[^}]*code/);
  assert.match(main, /const MS_ACCOUNT_VAULT_PREFIX = 'microsoft_account_v1_'/);
  assert.match(main, /hostname:\s*'graph\.microsoft\.com'/);
  assert.match(main, /_secureHandle\('microsoft-fetch-mail'/);
  assert.match(main, /_secureHandle\('microsoft-send-mail'/);
  assert.match(main, /return \{ ok: true, \.\.\._msPublicStatus\(attempt\.accountId, record\) \}/);
  assert.doesNotMatch(preload, /refresh-ms-token|secret-get|secret-set|secret-remove/);
  assert.doesNotMatch(preload, /\baccessToken\b|\brefreshToken\b/);
});

test('Microsoft mail proxy accepts only the bounded app send schema', () => {
  const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const validAccountId = loadFunction('_validMsAccountId');
  const validSend = loadFunction('_validMicrosoftSendRequest', {
    _isPlainObject: isPlainObject,
    _validMsAccountId: validAccountId,
    Buffer,
  });
  const valid = {
    accountId: 'ms_123',
    message: {
      subject: 'Lesson receipt',
      body: { contentType: 'HTML', content: '<p>Thank you</p>' },
      toRecipients: [{ emailAddress: { address: 'client@example.com', name: 'Client' } }],
    },
    saveToSentItems: true,
  };
  assert.equal(validSend(valid), true);
  assert.equal(validSend({ ...valid, accountId: '../other-account' }), false);
  assert.equal(validSend({
    ...valid,
    message: { ...valid.message, subject: 'hello\r\nBcc: attacker@example.com' },
  }), false);
  assert.equal(validSend({
    ...valid,
    message: {
      ...valid.message,
      toRecipients: [{ emailAddress: { address: 'not-an-email' } }],
    },
  }), false);
  assert.equal(validSend({ ...valid, arbitraryGraphPath: '/v1.0/users' }), false);
});

test('main-owned app sessions gate sensitive authority with explicit roles', () => {
  assert.match(main, /const APP_PROFILE_ROLES = Object\.freeze/);
  assert.match(main, /const COMMUNICATION_ROLES = new Set/);
  assert.match(main, /function _requireAppRole\(allowedRoles\)/);
  assert.match(main, /_secureHandle\('anthropic-key-set'[\s\S]*?_requireAppRole\(new Set\(\['Owner'\]\)\)/);
  assert.match(main, /_secureHandle\('ringcentral-configure'[\s\S]*?_requireAppRole\(new Set\(\['Owner'\]\)\)/);
  assert.match(main, /_secureHandle\('ringcentral-send-sms'[\s\S]*?_requireAppRole\(COMMUNICATION_ROLES\)/);
  assert.match(main, /_secureHandle\('firebase-runtime-config'[\s\S]*?_requireAppRole\(new Set\(\['Owner'\]\)\)/);
  assert.match(main, /Trust-on-first-use \(TOFU\) upgrade bootstrap/);
  assert.match(main, /defense-in-depth for subsequent sessions, not a[\s\S]*cryptographic boundary/);
  assert.match(main, /ownerAuthFailures >= 5/);
});

test('added login users are main-owned and can only receive Front Desk authority', () => {
  assert.match(main, /const STAFF_PROFILES_VAULT_KEY = 'app_staff_profiles_v1'/);
  assert.match(main, /const MAX_CUSTOM_STAFF_PROFILES = 50/);
  assert.match(main, /function _normalizeStaffProfileName\(value\)/);
  assert.match(main, /name\.toLocaleLowerCase\('en-US'\) === 'team'/);
  assert.match(
    main,
    /_secureHandle\('app-session-add-staff-profile'[\s\S]*profiles\.push\(\{ name, role: 'Front Desk', createdAt: Date\.now\(\) \}\)/
  );
  assert.match(
    main,
    /_secureHandle\('app-session-start-staff'[\s\S]*const role = _roleForAppProfile\(name\)[\s\S]*role === 'Owner'/
  );
  assert.doesNotMatch(
    main,
    /app-session-add-staff-profile'[\s\S]{0,1200}(?:requestedRole|request\.role|role:\s*requested)/
  );
  assert.match(preload, /listProfiles:\s*\(\) => ipcRenderer\.invoke\('app-session-list-profiles'\)/);
  assert.match(preload, /addStaffProfile:\s*\(name\) => ipcRenderer\.invoke\('app-session-add-staff-profile', name\)/);
});

test('added profile validation is Unicode-safe, duplicate-safe, and role-fixed', () => {
  const roles = Object.freeze({
    'Elizabeth Chaves': 'Owner',
    'Carrie Gass': 'Operations & Events',
    'Ana Chaves': 'Front Desk',
    'Emma Minnetto': 'Front Desk',
  });
  const normalizeSandbox = {};
  const normalizeStart = main.indexOf('function _normalizeStaffProfileName(');
  const normalizeEnd = main.indexOf('\nfunction _customStaffProfilesFromVault(', normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  vm.runInNewContext(
    `${main.slice(normalizeStart, normalizeEnd)}; this.normalize = _normalizeStaffProfileName;`,
    normalizeSandbox
  );
  const normalize = normalizeSandbox.normalize;
  const profilesFromVault = loadFunction('_customStaffProfilesFromVault', {
    STAFF_PROFILES_VAULT_KEY: 'app_staff_profiles_v1',
    MAX_CUSTOM_STAFF_PROFILES: 50,
    APP_PROFILE_ROLES: roles,
    _isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    _normalizeStaffProfileName: normalize,
  });
  assert.equal(normalize("  Zoë   O'Neil  "), "Zoë O'Neil");
  assert.equal(normalize('Name\nInjected'), 'Name Injected');
  for (const invalid of ['Team', '<script>', 'x'.repeat(81)]) {
    assert.throws(() => normalize(invalid));
  }
  const valid = profilesFromVault({
    app_staff_profiles_v1: [{
      name: "Quinn O'Neil",
      role: 'Front Desk',
      createdAt: 1,
    }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(valid)), [{
    name: "Quinn O'Neil",
    role: 'Front Desk',
    createdAt: 1,
  }]);
  assert.throws(() => profilesFromVault({
    app_staff_profiles_v1: [{ name: 'Quinn Owner', role: 'Owner', createdAt: 1 }],
  }));
  assert.throws(() => profilesFromVault({
    app_staff_profiles_v1: [{ name: 'Ana Chaves', role: 'Front Desk', createdAt: 1 }],
  }));
});

test('owner passcode rotation is staged before its verifier is committed', () => {
  assert.match(main, /_secureHandle\('app-session-stage-owner-pin'/);
  assert.match(main, /record\.pending = \{[\s\S]*rotationId,[\s\S]*verifier: await _buildOwnerVerifier/);
  assert.match(main, /_secureHandle\('app-session-commit-owner-pin'/);
  assert.match(main, /record\.active = record\.pending\.verifier/);
  assert.match(preload, /stageOwnerPin/);
  assert.match(preload, /commitOwnerPin/);
  assert.match(preload, /cancelOwnerPin/);
});

test('file imports use a one-time opaque capability instead of renderer paths', () => {
  assert.match(main, /const selectedFileCapabilities = new Map\(\)/);
  assert.match(main, /`mbfile:\$\{crypto\.randomBytes\(24\)\.toString\('base64url'\)\}`/);
  assert.match(main, /selectedFileCapabilities\.delete\(token\)/);
  assert.match(main, /filePaths:\s*\[token\],\s*fileNames:\s*\[path\.basename\(selectedPath\)\]/);
  assert.doesNotMatch(main, /_secureHandle\('read-text-file'[^]*?path\.extname\(filePath\)/);
  const prune = extractFunction(main, '_pruneFileCapabilities');
  assert.equal((prune.match(/for\s*\(/g) || []).length, 1, 'capability pruning is linear');
});

test('unused native iMessage authority is removed', () => {
  assert.doesNotMatch(main, /fetch-imessages|send-imessage|chat\.db|osascript/);
  assert.doesNotMatch(preload, /electronMessages/);
});

test('safeStorage is mandatory and arbitrary renderer vault access is removed', () => {
  assert.match(main, /Secure credential storage is unavailable/);
  assert.doesNotMatch(main, /using plain file|key stored as plain file/);
  assert.match(main, /renderer-secrets-v1\.bin/);
  assert.match(main, /const MS_ACCOUNT_VAULT_PREFIX = 'microsoft_account_v1_'/);
  assert.doesNotMatch(main, /_secureHandle\('secret-(?:get|set|remove)'/);
  assert.doesNotMatch(preload, /exposeInMainWorld\('electronSecrets'/);
  assert.doesNotMatch(main, /console\.(?:log|warn)\([^)]*(?:access_token|refresh_token|Exchange result|Code received)/i);
  assert.doesNotMatch(main, /raw:\s*data/);
});

test('iCloud writes are bounded, nonblocking, and atomically renamed', () => {
  assert.match(main, /const MAX_SYNC_BYTES = 8 \* 1024 \* 1024/);
  assert.match(main, /await fs\.promises\.open\(tempPath,\s*'wx'/);
  assert.match(main, /await handle\.sync\(\)/);
  assert.match(main, /await fs\.promises\.rename\(tempPath,\s*targetPath\)/);
  assert.match(main, /const write = iCloudWriteChain\.then/);
  assert.doesNotMatch(main, /writeFileSync\(ICLOUD_SYNC_PATH|readFileSync\(ICLOUD_SYNC_PATH/);
});

test('GUI tests can isolate iCloud only inside the temp directory and never in packaged builds', () => {
  const resolver = extractFunction(main, '_resolveICloudDirectory');
  assert.match(resolver, /if \(app\.isPackaged \|\| !override\) return productionDirectory/);
  assert.match(resolver, /fs\.realpathSync\(path\.resolve\(override\)\)/);
  assert.match(resolver, /fs\.realpathSync\(os\.tmpdir\(\)\)/);
  assert.match(resolver, /relative\.startsWith\('\.\.'\) \|\| path\.isAbsolute\(relative\)/);
  assert.match(resolver, /fs\.statSync\(resolvedOverride\)\.isDirectory\(\)/);
  assert.match(main, /const ICLOUD_DIR = _resolveICloudDirectory\(\)/);
});

test('updates are explicit, report errors, and wait for successful save flush', () => {
  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = false/);
  assert.doesNotMatch(main, /checkForUpdatesAndNotify/);
  assert.match(main, /function _checkForUpdatesAndStartDownload\(\)/);
  assert.match(main, /result\?\.isUpdateAvailable === true/);
  assert.match(main, /await autoUpdater\.downloadUpdate\(\)/);
  assert.match(main, /let updateDownloadPromise = null/);
  assert.match(main, /catch \(err\) \{\s*_reportUpdaterError\(err\);\s*return false;/);
  assert.match(main, /nativeAutoUpdater\.on\('before-quit-for-update'/);
  assert.match(main, /const flushed = await _requestRendererFlush\(\)/);
  assert.match(main, /if \(!flushed\)[\s\S]*update was not installed/);
  const installHandler = main.slice(main.indexOf("_secureHandle('quit-and-install'"));
  assert.doesNotMatch(
    installHandler.slice(0, installHandler.indexOf('// ── IPC: AES-256-GCM')),
    /allowImmediateQuit\s*=\s*true/,
    'install request cannot bypass quit until the native updater signal'
  );
  assert.doesNotMatch(main, /fallback: forcing app\.quit/);
  assert.match(preload, /onUpdateError:\s*\(cb\) => subscribe\('update-error', cb\)/);
  assert.match(preload, /onFlushRequested/);
  assert.match(preload, /await callback\(\)/);
  assert.match(preload, /renderer-flush-complete/);
});

test('preload exposes narrow APIs and listeners can be unsubscribed', () => {
  assert.match(preload, /ipcRenderer\.removeListener/);
  assert.match(preload, /exposeInMainWorld\('electronSession'/);
  assert.match(preload, /exposeInMainWorld\('electronMicrosoft'/);
  assert.match(preload, /exposeInMainWorld\('electronFirebase'/);
  assert.match(preload, /exposeInMainWorld\('electronAI'/);
  assert.match(preload, /exposeInMainWorld\('electronRingCentral'/);
  assert.match(preload, /exposeInMainWorld\('electronLifecycle'/);
  assert.doesNotMatch(preload, /secret-(?:get|set|remove)|refresh-ms-token/);
  assert.match(preload, /if \(flushListener === listener\) flushListener = null/);
  assert.doesNotMatch(preload, /sendSync|executeJavaScript|exposeInMainWorld\([^,]+,\s*ipcRenderer/);
});

test('receipt PDF renderer cannot load network or arbitrary local subresources', () => {
  assert.match(main, /\{ urls: \['file:\/\/\*\/\*', 'http:\/\/\*\/\*', 'https:\/\/\*\/\*'\] \}/);
  assert.match(main, /const isOwnTopDocument = details\.resourceType === 'mainFrame'/);
  assert.match(main, /javascript:\s*false/);
  assert.match(main, /Generated PDF exceeds the 20 MB limit/);
  assert.match(main, /showSaveDialog/);
  assert.match(main, /await _atomicWriteFile\(destination,\s*pdfBuffer/);
  assert.doesNotMatch(main, /pdfBuffer\.toString\('base64'\)/);
});

test('PDF import uses a bounded utility process with expression evaluation disabled', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'pdf-worker.js'), 'utf8');
  assert.match(main, /utilityProcess\.fork\(workerPath/);
  assert.match(main, /--max-old-space-size=256/);
  assert.match(main, /PDF extraction timed out after 20 seconds/);
  assert.match(worker, /isEvalSupported:\s*false/);
  assert.match(worker, /MAX_PDF_BYTES = 20 \* 1024 \* 1024/);
  assert.match(worker, /MAX_PAGES = 500/);
  assert.doesNotMatch(main, /pdf-parse\/lib\/pdf-parse\.js/);
  assert.doesNotMatch(main, /_execFileText\(['"](?:pdftotext|python3)['"]/);
  assert.match(main, /_execFileText\('\/usr\/bin\/textutil'/);
});

test('spreadsheet import and recovery use bounded main-process capabilities', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'spreadsheet-worker.js'), 'utf8');
  assert.match(main, /_secureHandle\('import-spreadsheet'/);
  assert.match(main, /_requireAppRole\(COMMUNICATION_ROLES\)/);
  assert.match(main, /MAX_SPREADSHEET_SOURCE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(main, /Music Box Spreadsheet Parser/);
  assert.match(main, /Spreadsheet import timed out after 20 seconds/);
  assert.match(worker, /const MAX_GRID_CELLS = 10000/);
  assert.match(worker, /const MAX_TOTAL_CHARS = 400000/);
  assert.ok(
    worker.indexOf('validateWorksheetRange(XLSX, worksheet, totals)') <
      worker.indexOf('XLSX.utils.sheet_to_json(worksheet'),
    'declared XLSX dimensions are checked before row expansion'
  );
  assert.match(main, /_secureHandle\('export-spreadsheet-recovery'/);
  assert.match(main, /MAX_SPREADSHEET_RECOVERY_BYTES = 8 \* 1024 \* 1024/);
  assert.match(main, /await _atomicWriteFile\(destination, contents, 0o600\)/);
  assert.match(preload, /exposeInMainWorld\('electronSpreadsheet'/);
  assert.match(preload, /ipcRenderer\.invoke\('import-spreadsheet'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('export-spreadsheet-recovery', contents\)/);
});

test('only exact packaged vendor scripts are admitted by the file request gate', () => {
  assert.match(main, /const TRUSTED_VENDOR_RELATIVE_PATHS = new Set/);
  assert.match(main, /details\.resourceType === 'script'/);
  assert.match(main, /details\.webContentsId === mainWindow\.webContents\.id/);
  assert.match(main, /_isTrustedVendorUrl\(details\.url\)/);
  assert.doesNotMatch(main, /details\.url\.startsWith/);
});

test('AI and RingCentral secrets stay behind dedicated main-process proxies', () => {
  assert.match(main, /const ANTHROPIC_SECRET_KEY = 'anthropic_api_key'/);
  assert.match(main, /hostname:\s*'api\.anthropic\.com'/);
  assert.match(main, /path:\s*'\/v1\/messages'/);
  assert.match(main, /MAX_AI_REQUEST_BYTES = 12 \* 1024 \* 1024/);
  assert.match(main, /activeAiRequests >= 2/);
  assert.match(main, /const RC_SECRET_KEYS = Object\.freeze/);
  assert.match(main, /hostname:\s*'platform\.ringcentral\.com'/);
  assert.match(main, /rcAccessTokenExpiry/);
  assert.doesNotMatch(preload, /accessToken|clientSecret|x-api-key|Authorization/);

  const normalizePhone = loadFunction('_normalizeRcPhone');
  assert.equal(normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('555-123-4567'), null);
  assert.equal(normalizePhone('+1; rm -rf /'), null);
});

test('main does not swallow uncaught exceptions and continue in corrupt state', () => {
  assert.doesNotMatch(main, /process\.on\(['"]uncaughtException/);
});

// --- Profile removal: functional stress tests -------------------------------
//
// These execute the REAL handler body against a simulated vault rather than
// pattern-matching source, so guard regressions actually fail.

// extractFunction() brace-matches and is confused by regex literals that
// contain an apostrophe (e.g. /^[\p{L}\p{M}\d .'-]+$/u). These helpers are
// plain top-level declarations, so slice to the next declaration instead.
function sliceFunction(source, name) {
  // Prefer the async declaration: starting at `function X(` inside
  // `async function X(` would silently drop the async keyword.
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const ends = [
    source.indexOf('\nfunction ', start + 1),
    source.indexOf('\nasync function ', start + 1),
    source.indexOf('\nconst ', start + 1),
    source.indexOf('\n_secureHandle(', start + 1),
  ].filter(i => i > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : source.length);
}

function extractHandlerBody(source, channel) {
  const marker = `_secureHandle('${channel}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${channel} handler exists`);
  const braceStart = source.indexOf('{', source.indexOf('=>', start));
  let depth = 0, quote = null, escaped = false;
  for (let i = braceStart; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return source.slice(braceStart + 1, i); }
  }
  throw new Error(`could not extract ${channel}`);
}

function removalHarness({ role = 'Owner', signedInAs = 'Elizabeth Chaves', vault } = {}) {
  const state = {
    vault: vault ?? {
      app_staff_profiles_v1: [
        { name: 'Dana Reed', role: 'Front Desk', createdAt: 1 },
        { name: 'Sam Vega', role: 'Front Desk', createdAt: 2 },
      ],
    },
    savedTimes: 0,
  };
  const context = vm.createContext({
    Object, Error, Date, JSON, Set, Array, Number, String, Boolean, Buffer, console,
    _state: state,
  });
  vm.runInContext(`
    const APP_PROFILE_ROLES = Object.freeze({
      'Elizabeth Chaves': 'Owner', 'Carrie Gass': 'Operations & Events',
      'Ana Chaves': 'Front Desk', 'Emma Minnetto': 'Front Desk',
    });
    const STAFF_PROFILES_VAULT_KEY = 'app_staff_profiles_v1';
    const MAX_CUSTOM_STAFF_PROFILES = 50;
    let appSession = ${JSON.stringify({ name: signedInAs, role })};
    const _isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const _validOwnerVerifier = () => true;
    const _loadSecretVault = () => JSON.parse(JSON.stringify(_state.vault));
    const _saveSecretVault = v => { _state.vault = JSON.parse(JSON.stringify(v)); _state.savedTimes++; };
    function _requireAppRole(allowed) {
      if (!allowed.has(appSession.role)) {
        throw new Error('This signed-in profile is not authorized for that action.');
      }
      return appSession;
    }
    const PROFILE_ROLE_OVERRIDES_VAULT_KEY = 'app_profile_roles_v1';
    const REMOVED_BUILTIN_PROFILES_VAULT_KEY = 'app_removed_builtins_v1';
    const ASSIGNABLE_PROFILE_ROLES = Object.freeze(['Operations & Events', 'Front Desk']);
    ${sliceFunction(main, '_normalizeStaffProfileName')}
    ${sliceFunction(main, '_customStaffProfilesFromVault')}
    ${sliceFunction(main, '_profileRoleOverrides')}
    ${sliceFunction(main, '_removedBuiltInProfiles')}
    ${sliceFunction(main, '_boundedString')}
    ${sliceFunction(main, '_removedCustomProfiles')}
    var REMOVED_CUSTOM_PROFILES_VAULT_KEY = 'app_removed_custom_v1';
    var DIRECTORY_META_VAULT_KEY = 'app_directory_meta_v1';
    ${sliceFunction(main, '_allAppProfiles')}
    ${sliceFunction(main, '_ownerProfileCount')}
    ${sliceFunction(main, '_findProfileByFoldedName')}
    globalThis.setRole = async request => {
      ${extractHandlerBody(main, 'app-session-set-profile-role')}
    };
    globalThis.profiles = () => _allAppProfiles().map(p => p.name + ':' + p.role);
    globalThis.remove = async requestedName => {
      ${extractHandlerBody(main, 'app-session-remove-staff-profile')}
    };
    globalThis.list = () => _customStaffProfilesFromVault(_loadSecretVault()).map(p => p.name);
  `, context);
  return { api: context, state };
}

test('profile removal: removes an added user and leaves the others intact', async () => {
  const { api, state } = removalHarness();
  const result = await api.remove('Dana Reed');
  assert.equal(result.ok, true);
  assert.deepEqual([...api.list()], ['Sam Vega']);
  assert.equal(state.savedTimes, 1, 'the vault is written exactly once');
});

test('profile removal: built-in profiles can now be removed by the owner', async () => {
  for (const name of ['Carrie Gass', 'Ana Chaves', 'Emma Minnetto']) {
    const { api } = removalHarness();
    const result = await api.remove(name);
    assert.equal(result.ok, true, name);
    assert.ok(![...api.profiles()].some(p => p.startsWith(name + ':')),
      `${name} is gone from the resolved profile list`);
  }
});

test('profile removal: the last Owner can never be removed', async () => {
  // Signed in as someone else so the self-removal guard is not what blocks it.
  const { api } = removalHarness({ signedInAs: 'Sam Vega' });
  await assert.rejects(() => api.remove('Elizabeth Chaves'), /last Owner profile cannot be removed/);
  assert.ok([...api.profiles()].includes('Elizabeth Chaves:Owner'),
    'the owner survives, so administration is never lost');
});

test('profile removal: only the owner may remove a user', async () => {
  for (const role of ['Front Desk', 'Operations & Events']) {
    const { api } = removalHarness({ role, signedInAs: 'Sam Vega' });
    await assert.rejects(() => api.remove('Dana Reed'), /not authorized/, role);
    assert.deepEqual([...api.list()], ['Dana Reed', 'Sam Vega']);
  }
});

test('profile removal: the signed-in profile cannot delete itself', async () => {
  const { api } = removalHarness({ signedInAs: 'Dana Reed' });
  await assert.rejects(() => api.remove('Dana Reed'), /currently signed in/);
  assert.deepEqual([...api.list()], ['Dana Reed', 'Sam Vega']);
});

test('profile removal: an unknown user is reported, not silently accepted', async () => {
  const { api, state } = removalHarness();
  await assert.rejects(() => api.remove('Nobody Here'), /was not found/);
  assert.equal(state.savedTimes, 0, 'no write happens on a failed removal');
});

test('profile removal: matching is case- and whitespace-insensitive', async () => {
  for (const variant of ['dana reed', 'DANA REED', '  Dana   Reed  ']) {
    const { api } = removalHarness();
    await api.remove(variant);
    assert.deepEqual([...api.list()], ['Sam Vega'], `matched "${variant}"`);
  }
});

test('profile removal: invalid names are rejected before any vault write', async () => {
  for (const bad of ['', 'x', 'A'.repeat(81), 'Team', 'bad<name>']) {
    const { api, state } = removalHarness();
    await assert.rejects(() => api.remove(bad));
    assert.equal(state.savedTimes, 0, `no write for ${JSON.stringify(bad)}`);
  }
});

test('profile removal: removing the last user cleans up the vault key', async () => {
  const { api, state } = removalHarness({
    vault: { app_staff_profiles_v1: [{ name: 'Dana Reed', role: 'Front Desk', createdAt: 1 }] },
  });
  await api.remove('Dana Reed');
  assert.equal(state.vault.app_staff_profiles_v1, undefined, 'no empty array is left behind');
  assert.deepEqual([...api.list()], []);
});

test('profile removal: repeated removal is safe and never double-writes', async () => {
  const { api, state } = removalHarness();
  await api.remove('Dana Reed');
  await assert.rejects(() => api.remove('Dana Reed'), /was not found/);
  assert.equal(state.savedTimes, 1);
  assert.deepEqual([...api.list()], ['Sam Vega']);
});

test('profile removal: removing every user in turn leaves a consistent vault', async () => {
  const { api, state } = removalHarness();
  await api.remove('Dana Reed');
  await api.remove('Sam Vega');
  assert.deepEqual([...api.list()], []);
  assert.equal(state.vault.app_staff_profiles_v1, undefined);
  assert.equal(state.savedTimes, 2);
});

test('profile removal: logs, notes and tasks are never touched by a removal', async () => {
  const body = extractHandlerBody(main, 'app-session-remove-staff-profile');
  // Deleting a login must never delete the logs, notes or tasks that person
  // created. The handler may only ever touch the two credential vault keys.
  for (const forbidden of ['logs', 'staff_notes', 'assigned_tasks', 'todo_items',
                           'step_up_receipts', 'policies', 'STORE']) {
    assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`),
      `removal must not reference ${forbidden}`);
  }
  assert.match(body, /STAFF_PROFILES_VAULT_KEY/);
});

test('profile removal: the owner UI exposes Remove and refreshes everywhere', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /id="manage-profiles-section"/, 'the settings block exists');
  assert.match(renderer, /id="manage-profiles-list"/, 'the list container exists');
  assert.match(renderer, /onclick="removeLoginUser\(/, 'a Remove control invokes removal');
  assert.match(renderer, /getElementById\('manage-profiles-section'\)[\s\S]{0,140}isElizabeth\(\)/,
    'the block is owner-only');
  const refresh = renderer.slice(renderer.indexOf('async function refreshLoginProfiles('));
  const body = refresh.slice(0, refresh.indexOf('\nfunction ', 1));
  assert.match(body, /renderLoginProfiles\(\)/, 'login screen refreshes');
  assert.match(body, /populateProfileSelects\(\)/, 'task dropdowns refresh');
  assert.match(body, /renderManageProfiles\(\)/, 'the manage list refreshes');
  assert.match(body, /renderMyTasks\(\)/, 'task views refresh');
});

test('profile removal: preload exposes removal without widening the surface', () => {
  assert.match(preload,
    /removeStaffProfile:\(name\) => ipcRenderer\.invoke\('app-session-remove-staff-profile', name\)/,
    'the renderer can only pass a name; main enforces every rule');
});

// --- Role assignment: functional stress tests -------------------------------

test('role change: any profile can be given Operations & Events', async () => {
  // The whole point: Operations & Events is not limited to one person.
  const { api } = removalHarness();
  await api.setRole({ name: 'Dana Reed', role: 'Operations & Events' });
  const list = [...api.profiles()];
  assert.ok(list.includes('Dana Reed:Operations & Events'), 'the added user is promoted');
  assert.ok(list.includes('Carrie Gass:Operations & Events'), 'Carrie keeps hers too');
});

test('role change: a built-in profile can be re-roled', async () => {
  const { api } = removalHarness();
  await api.setRole({ name: 'Ana Chaves', role: 'Operations & Events' });
  assert.ok([...api.profiles()].includes('Ana Chaves:Operations & Events'));
  await api.setRole({ name: 'Carrie Gass', role: 'Front Desk' });
  assert.ok([...api.profiles()].includes('Carrie Gass:Front Desk'),
    'a built-in can also be demoted');
});

test('role change: returning to the shipped role stores no override', async () => {
  const { api, state } = removalHarness();
  await api.setRole({ name: 'Carrie Gass', role: 'Front Desk' });
  assert.deepEqual(Object.keys(state.vault.app_profile_roles_v1), ['Carrie Gass']);
  await api.setRole({ name: 'Carrie Gass', role: 'Operations & Events' });
  assert.equal(state.vault.app_profile_roles_v1, undefined,
    'the override is cleaned up rather than pinning the default forever');
});

test('role change: Owner cannot be assigned to anyone', async () => {
  for (const name of ['Dana Reed', 'Carrie Gass', 'Ana Chaves']) {
    const { api } = removalHarness();
    await assert.rejects(() => api.setRole({ name, role: 'Owner' }), /Role must be one of/, name);
  }
});

test('role change: the last Owner cannot be demoted', async () => {
  const { api } = removalHarness();
  await assert.rejects(
    () => api.setRole({ name: 'Elizabeth Chaves', role: 'Front Desk' }),
    /last Owner profile cannot be demoted/
  );
  assert.ok([...api.profiles()].includes('Elizabeth Chaves:Owner'));
});

test('role change: unknown roles and names are rejected', async () => {
  const { api, state } = removalHarness();
  for (const role of ['Admin', '', null, 'front desk']) {
    await assert.rejects(() => api.setRole({ name: 'Dana Reed', role }));
  }
  await assert.rejects(() => api.setRole({ name: 'Nobody', role: 'Front Desk' }), /not found/);
  assert.equal(state.savedTimes, 0, 'no write on any rejected change');
});

test('role change: only the owner may change roles', async () => {
  for (const role of ['Front Desk', 'Operations & Events']) {
    const { api } = removalHarness({ role, signedInAs: 'Sam Vega' });
    await assert.rejects(
      () => api.setRole({ name: 'Dana Reed', role: 'Operations & Events' }),
      /not authorized/
    );
  }
});

test('role change: a no-op change is reported and writes nothing', async () => {
  const { api, state } = removalHarness();
  const result = await api.setRole({ name: 'Dana Reed', role: 'Front Desk' });
  assert.equal(result.unchanged, true);
  assert.equal(state.savedTimes, 0);
});

test('role change: removing a re-roled profile clears its override', async () => {
  const { api, state } = removalHarness();
  await api.setRole({ name: 'Dana Reed', role: 'Operations & Events' });
  assert.ok(state.vault.app_profile_roles_v1['Dana Reed']);
  await api.remove('Dana Reed');
  assert.equal(state.vault.app_profile_roles_v1, undefined,
    're-adding the name later must not silently restore elevated access');
});

test('role change: a removed built-in stops resolving to its shipped role', async () => {
  const { api } = removalHarness();
  await api.remove('Carrie Gass');
  assert.ok(![...api.profiles()].some(p => p.startsWith('Carrie Gass:')));
});

test('role change: capability checks in the renderer are role-based, not name-based', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('function hasOperationsRole('));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.match(body, /getUserRole\(currentUser\(\)\) === 'Operations & Events'/,
    'the capability follows the role');
  assert.doesNotMatch(body, /Carrie Gass/,
    'no hard-coded name, or a newly promoted person would get nothing');
  // isCarrie() is the historical call site name and must delegate.
  const legacy = renderer.slice(renderer.indexOf('function isCarrie('));
  assert.match(legacy.slice(0, legacy.indexOf('\n}') + 2), /hasOperationsRole\(\)/);
});

test('role change: the renderer no longer requires every built-in to exist', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(renderer, /A required built-in user profile is missing/,
    'built-ins are removable, so that check would break the app');
  assert.match(renderer, /The protected user-profile list has no owner/,
    'but a list with no owner is still treated as corrupt');
});

test('role change: the owner UI exposes a role control and preload passes it through', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /onchange="setProfileRole\(/, 'a role control exists');
  assert.match(renderer, /async function setProfileRole\(/, 'the handler exists');
  assert.match(renderer, /applyRolePermissions\(\)/,
    'nav and page permissions are re-applied after a role change');
  assert.match(preload,
    /setProfileRole:\s+\(request\) => ipcRenderer\.invoke\('app-session-set-profile-role', request\)/);
});

// --- V159-005: synchronized staff directory ---------------------------------
//
// The renderer transports the directory but must not be able to decide roles.
// These execute the real _buildStaffDirectory/_applyStaffDirectory against a
// simulated vault.

function directoryHarness({ role = 'Owner', signedInAs = 'Elizabeth Chaves', vault } = {}) {
  const state = {
    vault: vault ?? { app_staff_profiles_v1: [{ name: 'Dana Reed', role: 'Front Desk', createdAt: 1 }] },
    savedTimes: 0,
    sessionReset: false,
  };
  const context = vm.createContext({
    Object, Error, Date, JSON, Set, Array, Number, String, Boolean, Buffer, console,
    _state: state,
  });
  vm.runInContext(`
    const APP_PROFILE_ROLES = Object.freeze({
      'Elizabeth Chaves': 'Owner', 'Carrie Gass': 'Operations & Events',
      'Ana Chaves': 'Front Desk', 'Emma Minnetto': 'Front Desk',
    });
    const STAFF_PROFILES_VAULT_KEY = 'app_staff_profiles_v1';
    const PROFILE_ROLE_OVERRIDES_VAULT_KEY = 'app_profile_roles_v1';
    const REMOVED_BUILTIN_PROFILES_VAULT_KEY = 'app_removed_builtins_v1';
    const ASSIGNABLE_PROFILE_ROLES = Object.freeze(['Operations & Events', 'Front Desk']);
    const MAX_CUSTOM_STAFF_PROFILES = 50;
    const MAX_DIRECTORY_ENTRIES = MAX_CUSTOM_STAFF_PROFILES + 16;
    let appSession = ${JSON.stringify({ name: signedInAs, role })};
    const _isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const _loadSecretVault = () => JSON.parse(JSON.stringify(_state.vault));
    const _saveSecretVault = v => { _state.vault = JSON.parse(JSON.stringify(v)); _state.savedTimes++; };
    const _resetAppSession = () => { appSession = null; _state.sessionReset = true; };
    ${sliceFunction(main, '_normalizeStaffProfileName')}
    ${sliceFunction(main, '_customStaffProfilesFromVault')}
    ${sliceFunction(main, '_profileRoleOverrides')}
    ${sliceFunction(main, '_removedBuiltInProfiles')}
    ${sliceFunction(main, '_boundedString')}
    ${sliceFunction(main, '_removedCustomProfiles')}
    var REMOVED_CUSTOM_PROFILES_VAULT_KEY = 'app_removed_custom_v1';
    var DIRECTORY_META_VAULT_KEY = 'app_directory_meta_v1';
    ${sliceFunction(main, '_allAppProfiles')}
    ${sliceFunction(main, '_roleForAppProfile')}
    ${sliceFunction(main, '_directoryEntryId')}
    ${sliceFunction(main, '_directoryMeta')}
    ${sliceFunction(main, '_directoryEntryDigest')}
    ${sliceFunction(main, '_stampDirectoryEntry')}
    ${sliceFunction(main, '_buildStaffDirectory')}
    ${sliceFunction(main, '_validDirectoryEntry')}
    ${sliceFunction(main, '_applyStaffDirectory')}
    globalThis.build = () => _buildStaffDirectory();
    globalThis.apply = d => _applyStaffDirectory(d);
    globalThis.profiles = () => _allAppProfiles().map(p => p.name + ':' + p.role);
    globalThis.session = () => appSession;
  `, context);
  return { api: context, state };
}

test('directory: a published directory reproduces the owner profile set elsewhere', () => {
  const source = directoryHarness();
  const directory = [...source.api.build()].map(e => ({ ...e }));
  // A second Mac with only its shipped defaults.
  const target = directoryHarness({ vault: {} });
  assert.ok(![...target.api.profiles()].includes('Dana Reed:Front Desk'), 'not there yet');
  target.api.apply(directory);
  assert.ok([...target.api.profiles()].includes('Dana Reed:Front Desk'),
    'the added user now exists on the second Mac');
});

test('directory: a role change propagates', () => {
  const source = directoryHarness({
    vault: {
      app_staff_profiles_v1: [{ name: 'Dana Reed', role: 'Front Desk', createdAt: 1 }],
      app_profile_roles_v1: { 'Dana Reed': 'Operations & Events' },
    },
  });
  const target = directoryHarness({ vault: {} });
  target.api.apply([...source.api.build()].map(e => ({ ...e })));
  assert.ok([...target.api.profiles()].includes('Dana Reed:Operations & Events'));
});

test('directory: a removed built-in propagates as a tombstone', () => {
  const source = directoryHarness({
    vault: { app_removed_builtins_v1: ['Emma Minnetto'] },
  });
  const directory = [...source.api.build()].map(e => ({ ...e }));
  assert.ok(directory.some(e => e.name === 'Emma Minnetto' && e._deleted === true),
    'the removal travels as a tombstone, not an omission');
  const target = directoryHarness({ vault: {} });
  target.api.apply(directory);
  assert.ok(![...target.api.profiles()].some(p => p.startsWith('Emma Minnetto:')),
    'the second Mac applies the removal instead of resurrecting from defaults');
});

test('directory: an imported record can NEVER grant Owner', () => {
  const target = directoryHarness({ vault: {} });
  target.api.apply([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner', builtIn: true },
    { id: 'profile:mallory', name: 'Mallory', role: 'Owner', builtIn: false },
    { id: 'profile:ana chaves', name: 'Ana Chaves', role: 'Owner', builtIn: true },
  ]);
  const list = [...target.api.profiles()];
  assert.ok(!list.includes('Mallory:Owner'), 'a forged Owner entry is refused');
  assert.ok(!list.includes('Ana Chaves:Owner'), 'a built-in cannot be promoted to Owner');
  assert.ok(list.includes('Elizabeth Chaves:Owner'), 'the real owner is unaffected');
});

test('directory: a tombstone for the owner is ignored, never applied', () => {
  // An owner tombstone is dropped outright rather than throwing, so a forged
  // directory cannot strip administration from a Mac even transiently.
  const target = directoryHarness({ vault: {} });
  target.api.apply([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner',
      builtIn: true, _deleted: true },
  ]);
  assert.ok([...target.api.profiles()].includes('Elizabeth Chaves:Owner'),
    'the owner survives a malicious or corrupt removal entry');
  assert.equal(target.state.vault.app_removed_builtins_v1, undefined,
    'and no owner suppression is recorded');
});

test('directory: unknown roles fall back to Front Desk rather than being trusted', () => {
  const target = directoryHarness({ vault: {} });
  target.api.apply([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner', builtIn: true },
    { id: 'profile:dana reed', name: 'Dana Reed', role: 'Superuser', builtIn: false },
  ]);
  assert.ok(![...target.api.profiles()].some(p => p.includes('Superuser')));
});

test('directory: malformed, duplicate and oversized payloads are rejected safely', () => {
  const target = directoryHarness({ vault: {} });
  assert.throws(() => target.api.apply('not an array'), /invalid/);
  assert.throws(() => target.api.apply(new Array(200).fill({ name: 'x', role: 'Front Desk' })), /invalid/);
  // Junk entries are skipped, not fatal.
  target.api.apply([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner', builtIn: true },
    null, 42, { name: 123, role: 'Front Desk' }, { name: 'ok name', role: null },
    { id: 'a', name: 'Dana Reed', role: 'Front Desk' },
    { id: 'b', name: 'dana reed', role: 'Operations & Events' },
  ]);
  const danas = [...target.api.profiles()].filter(p => p.toLowerCase().startsWith('dana reed:'));
  assert.equal(danas.length, 1, 'case-duplicate entries collapse to one');
});

test('directory: a signed-in session loses privileges the import revokes', () => {
  const target = directoryHarness({
    role: 'Operations & Events', signedInAs: 'Carrie Gass', vault: {},
  });
  target.api.apply([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner', builtIn: true },
    { id: 'profile:carrie gass', name: 'Carrie Gass', role: 'Front Desk', builtIn: true },
  ]);
  assert.equal(target.api.session().role, 'Front Desk',
    'the live session is downgraded immediately, not at next login');
});

test('directory: a session whose profile was removed is ended', () => {
  const target = directoryHarness({
    role: 'Front Desk', signedInAs: 'Emma Minnetto', vault: {},
  });
  target.api.apply([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner', builtIn: true },
    { id: 'profile:emma minnetto', name: 'Emma Minnetto', role: 'Front Desk',
      builtIn: true, _deleted: true },
  ]);
  assert.equal(target.state.sessionReset, true, 'the removed profile is signed out');
});

test('directory: export is owner-only, import is validated in main', () => {
  const exportBody = extractHandlerBody(main, 'app-session-export-directory');
  assert.match(exportBody, /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'only the owner publishes');
  const importBody = extractHandlerBody(main, 'app-session-import-directory');
  assert.match(importBody, /_applyStaffDirectory\(directory\)/,
    'import runs through the validating applier, not a raw vault write');
  assert.match(preload,
    /exportDirectory:\s+\(\) => ipcRenderer\.invoke\('app-session-export-directory'\)/);
  assert.match(preload,
    /importDirectory:\s+\(directory\) => ipcRenderer\.invoke\('app-session-import-directory', directory\)/);
});

test('directory: the renderer publishes on every profile change and merges on arrival', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /'staff_directory',/, 'it is a synchronized key');
  assert.match(renderer, /staff_directory: 'tombstoned-record-list'/,
    'two Macs editing different profiles merge instead of clobbering');
  assert.match(renderer, /if \(key === 'staff_directory'\)/, 'arrivals are applied');
  const publishes = (renderer.match(/await publishStaffDirectory\(\);/g) || []).length;
  assert.equal(publishes, 3, 'add, remove and role change each publish');
  // Only the owner may publish.
  const fn = renderer.slice(renderer.indexOf('async function publishStaffDirectory('));
  assert.match(fn.slice(0, fn.indexOf('\n}') + 2), /isElizabeth\(\)/);
});

// --- V159-008: immutable per-device iCloud snapshots -------------------------
//
// Runs the real snapshot helpers against a real temp directory, including a
// genuine two-device concurrent backup.

const osMod = require('node:os');
const cryptoMod = require('node:crypto');

function snapshotHarness(dir) {
  const context = vm.createContext({
    Object, Error, Date, JSON, Set, Array, Number, String, Boolean, Buffer,
    console, Promise, RegExp,
    fs: require('node:fs'),
    path: require('node:path'),
    os: osMod,
    crypto: cryptoMod,
    ICLOUD_DIR: dir,
    ICLOUD_SYNC_PATH: require('node:path').join(dir, 'sync.json'),
    MAX_SYNC_BYTES: 8 * 1024 * 1024,
    app: { getPath: () => dir },
    _isPlainObject: v => !!v && typeof v === 'object' && !Array.isArray(v),
  });
  // Take the real constants straight from main.js — re-typing the regex here
  // would silently lose its backslashes inside a template literal.
  const constBlock = main.slice(
    main.indexOf('const ICLOUD_SNAPSHOT_PREFIX'),
    main.indexOf('function _backupDeviceId(')
  );
  vm.runInContext(`
    ${constBlock}
    ${sliceFunction(main, '_backupDeviceId')}
    ${sliceFunction(main, '_snapshotFileName')}
    ${sliceFunction(main, '_listBackupSnapshots')}
    ${sliceFunction(main, '_pruneBackupSnapshots')}
    ${sliceFunction(main, '_readBackupCandidate')}
    globalThis.api = {
      name: (d, when) => _snapshotFileName(d, when),
      list: () => _listBackupSnapshots(),
      prune: async () => _pruneBackupSnapshots(await _listBackupSnapshots()),
      read: () => _readBackupCandidate(),
      deviceId: () => _backupDeviceId(),
    };
  `, context);
  return context.api;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(osMod.tmpdir(), 'mb-icloud-'));
}

test('V159-008: two Macs backing up concurrently both keep a recovery point', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  // Same instant, two different devices — the old shared sync.json would have
  // left exactly one survivor.
  const when = new Date('2026-08-01T12:00:00.000Z');
  const a = api.name('aaaaaaaaaaaa', when);
  const b = api.name('bbbbbbbbbbbb', when);
  assert.notEqual(a, b, 'device id keeps concurrent filenames distinct');
  fs.writeFileSync(path.join(dir, a), JSON.stringify({ from: 'A' }));
  fs.writeFileSync(path.join(dir, b), JSON.stringify({ from: 'B' }));
  const listed = [...await api.list()];
  assert.equal(listed.length, 2, 'both recovery points survive');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V159-008: the newest snapshot is returned', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  fs.writeFileSync(path.join(dir, api.name('aaaaaaaaaaaa', new Date('2026-08-01T10:00:00.000Z'))),
    JSON.stringify({ pick: 'older' }));
  fs.writeFileSync(path.join(dir, api.name('bbbbbbbbbbbb', new Date('2026-08-01T11:00:00.000Z'))),
    JSON.stringify({ pick: 'newer' }));
  const result = await api.read();
  assert.equal(result.data.pick, 'newer');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V159-008: a corrupt newest snapshot never hides an older good one', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  fs.writeFileSync(path.join(dir, api.name('aaaaaaaaaaaa', new Date('2026-08-01T10:00:00.000Z'))),
    JSON.stringify({ pick: 'good' }));
  fs.writeFileSync(path.join(dir, api.name('bbbbbbbbbbbb', new Date('2026-08-01T11:00:00.000Z'))),
    '{ truncated json');
  const result = await api.read();
  assert.equal(result.data.pick, 'good', 'recovery falls through to the last valid backup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V159-008: the legacy shared sync.json is still readable but never rewritten', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  fs.writeFileSync(path.join(dir, 'sync.json'), JSON.stringify({ legacy: true }));
  const result = await api.read();
  assert.equal(result.legacy, true, 'the pre-existing backup is honoured');
  assert.equal(result.data.legacy, true);
  // A snapshot supersedes it once one exists.
  fs.writeFileSync(path.join(dir, api.name('aaaaaaaaaaaa', new Date())), JSON.stringify({ fresh: 1 }));
  assert.equal((await api.read()).data.fresh, 1);
  // The write path must never target the shared filename again.
  const writeBody = extractHandlerBody(main, 'write-sync-file');
  assert.doesNotMatch(writeBody, /ICLOUD_SYNC_PATH/,
    'writes go to per-device snapshots only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V159-008: retention is bounded per device and never starves another Mac', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  for (let i = 0; i < 9; i++) {
    fs.writeFileSync(
      path.join(dir, api.name('aaaaaaaaaaaa', new Date(Date.UTC(2026, 7, 1, 10, i)))),
      JSON.stringify({ i })
    );
  }
  fs.writeFileSync(path.join(dir, api.name('bbbbbbbbbbbb', new Date(Date.UTC(2026, 7, 1, 9, 0)))),
    JSON.stringify({ from: 'B' }));
  await api.prune();
  const left = [...await api.list()];
  const aCount = left.filter(s => s.deviceId === 'aaaaaaaaaaaa').length;
  const bCount = left.filter(s => s.deviceId === 'bbbbbbbbbbbb').length;
  assert.equal(aCount, 5, 'the chatty device is capped');
  assert.equal(bCount, 1, "the other Mac's only recovery point is untouched");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V159-008: unrelated files in the folder are ignored', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  for (const junk of ['notes.txt', 'sync-.json', 'sync-bad-name.json', '.DS_Store']) {
    fs.writeFileSync(path.join(dir, junk), 'x');
  }
  assert.deepEqual([...await api.list()], [], 'only well-formed snapshots are considered');
  assert.equal(await api.read(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V159-008: the device id is stable and filename-safe', () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  const id = api.deviceId();
  assert.match(id, /^[a-f0-9]{12}$/, 'hex, bounded, no path characters');
  assert.equal(id, api.deviceId(), 'stable across calls');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an update failure is reported in language that names the real problem', () => {
  // electron-updater pastes the whole HTTP exchange into its message, including
  // a stock "check that your authentication token is correct" line that is
  // simply wrong for a public repository — it sent us hunting for a credential
  // problem that did not exist.
  const context = {};
  vm.runInNewContext(
    `${extractFunction(main, '_describeUpdaterError')}\nglobalThis.describe = _describeUpdaterError;`,
    context
  );
  const describe = context.describe;

  const realWorld = 'Cannot find latest-mac.yml in the latest release artifacts ' +
    '(https://github.com/x/y/releases/download/v1.1.60/latest-mac.yml): HttpError: 404 ' +
    '"method: GET url: ...\\nPlease double check that your authentication token is correct."';
  const explained = describe(realWorld);
  assert.match(explained, /no downloadable build attached/);
  assert.match(explained, /not with this Mac/, 'and says where the fault is not');
  assert.doesNotMatch(explained, /authentication token/, 'the misleading line is gone');

  assert.match(describe('Error: getaddrinfo ENOTFOUND github.com'), /Could not reach GitHub/);
  assert.match(describe('HttpError: 403 API rate limit exceeded'), /rate-limiting/);
  assert.match(describe('code signature check failed'), /signature check/);
  // Anything unrecognised must pass through rather than being flattened into a
  // useless generic message.
  assert.equal(describe('some novel failure'), null);

  assert.match(main, /console\.warn\('\[updater\] Error:', raw\)/,
    'the original text stays in the log so a real fault is still diagnosable');
});

test('any signed-in profile can start cloud sync, but only on a provisioned Mac', () => {
  // Staff previously had cloud sync only when the owner happened to sign in
  // first that session; otherwise they worked offline while the badge implied
  // otherwise. That was not a security boundary, it was a coin flip — a staff
  // renderer inheriting a live session already had full Firestore access.
  const handler = main.slice(main.indexOf("_secureHandle('firebase-runtime-config'"));
  const body = handler.slice(0, handler.indexOf('});') + 3);
  assert.match(body, /_requireAppRole\(new Set\(\['Owner', 'Operations & Events', 'Front Desk'\]\)\)/);
  // A session is still mandatory: this must not be reachable before login.
  assert.match(body, /_requireAppRole\(/);
  assert.match(body, /firebaseRuntimeSecretIssued/, 'and it is still issue-once per session');

  // Provisioning stays owner-only, so this releases an existing secret rather
  // than letting anyone create one.
  const configure = main.slice(main.indexOf("_secureHandle('firebase-configure'"));
  assert.match(configure.slice(0, 400), /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'writing the credential is still the owner alone');
  const clear = main.slice(main.indexOf("_secureHandle('firebase-clear'"));
  assert.match(clear.slice(0, 400), /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'and so is removing it');

  // Switching profiles must re-arm the one-shot, or the second profile in a
  // session would be refused its own credential.
  for (const fn of ['_resetAppSession', '_setAppSession']) {
    assert.match(extractFunction(main, fn), /firebaseRuntimeSecretIssued = false/,
      `${fn} re-arms the credential release`);
  }
});

// --- MB161-005: directory causality -----------------------------------------
//
// External audit: every entry published as version 1 with a fresh timestamp, so
// the merge had nothing to reason about. Removals of custom profiles were not
// published at all, and the other Mac put them straight back.

const dirEntries = harness => [...harness.api.build()].map(e => ({ ...e }));

test('MB161-005: an unchanged republish does not move version or timestamp', () => {
  const harness = directoryHarness();
  const first = dirEntries(harness);
  const second = dirEntries(harness);
  assert.deepEqual(second, first,
    'republishing an unchanged directory is byte-identical, so it cannot manufacture conflicts');
  assert.ok(first.every(entry => Number.isSafeInteger(entry.version) && entry.version >= 1));
});

test('MB161-005: a real change advances only that entry', () => {
  const harness = directoryHarness();
  const before = dirEntries(harness);
  const target = before.find(entry => entry.name === 'Dana Reed');
  harness.state.vault.app_profile_roles_v1 = { 'Dana Reed': 'Operations & Events' };
  const after = dirEntries(harness);
  const changed = after.find(entry => entry.name === 'Dana Reed');
  assert.equal(changed.role, 'Operations & Events');
  assert.equal(changed.version, target.version + 1, 'the changed entry advances');
  for (const entry of after) {
    if (entry.name === 'Dana Reed') continue;
    assert.deepEqual(entry, before.find(e => e.id === entry.id), `${entry.name} was not touched`);
  }
});

test('MB161-005: removing a custom profile publishes a tombstone', () => {
  const harness = directoryHarness();
  dirEntries(harness);
  // What the removal handler records.
  delete harness.state.vault.app_staff_profiles_v1;
  harness.state.vault.app_removed_custom_v1 = [{ name: 'Dana Reed', at: '2026-08-05T00:00:00.000Z' }];
  const tombstone = dirEntries(harness).find(entry => entry.name === 'Dana Reed');
  assert.ok(tombstone, 'the removal is published rather than simply omitted');
  assert.equal(tombstone._deleted, true,
    'absence reads as "not seen" to the merge, so the other Mac would resurrect it');
  assert.ok(tombstone._deletedAt);
});

test('MB161-005: a removed custom profile does not come back from a stale peer', () => {
  const owner = directoryHarness();
  delete owner.state.vault.app_staff_profiles_v1;
  owner.state.vault.app_removed_custom_v1 = [{ name: 'Dana Reed', at: '2026-08-05T00:00:00.000Z' }];
  // The other Mac still holds the profile from before the removal.
  const peer = directoryHarness();
  assert.ok([...peer.api.profiles()].includes('Dana Reed:Front Desk'), 'peer has it to begin with');
  peer.api.apply(dirEntries(owner));
  assert.ok(![...peer.api.profiles()].some(p => p.startsWith('Dana Reed:')),
    'the tombstone removes it instead of the peer reintroducing it');
});

test('MB161-005: re-adding a removed name publishes it once, not alongside its deletion', () => {
  const harness = directoryHarness();
  delete harness.state.vault.app_staff_profiles_v1;
  harness.state.vault.app_removed_custom_v1 = [{ name: 'Dana Reed', at: '2026-08-05T00:00:00.000Z' }];
  dirEntries(harness);
  // What the add handler records: profile back, tombstone and meta cleared.
  harness.state.vault.app_staff_profiles_v1 = [{ name: 'Dana Reed', role: 'Front Desk', createdAt: 2 }];
  delete harness.state.vault.app_removed_custom_v1;
  delete harness.state.vault.app_directory_meta_v1['profile:dana reed'];
  const matches = dirEntries(harness).filter(entry => entry.name === 'Dana Reed');
  assert.equal(matches.length, 1, 'the profile is not published alongside its own deletion');
  assert.notEqual(matches[0]._deleted, true);
  assert.equal(matches[0].version, 1, 'the reused id does not inherit the old version');
});

test('MB161-005: adding a user that could not be published says so', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('async function addLoginUser'));
  const body = fn.slice(0, fn.indexOf('\nfunction ', 1));
  assert.match(body, /const published = await publishStaffDirectory\(\);/,
    'the publish result is read, not discarded');
  assert.match(body, /not yet[\s\S]*shared with the other Macs/,
    'and a local-only add is described as local-only');
});

// ── MB161-014: Google Sheets, read-only ─────────────────────────────────────
//
// Phase 1 of the sync plan is Google -> app only. The guarantee is not "we did
// not write the code" — it is that the OAuth scope requested is
// spreadsheets.readonly, so Google refuses a write even if something here were
// wrong. These tests hold that line.

function googleHelpers() {
  const context = vm.createContext({ String, Number, Math, RegExp });
  const slice = name => {
    const start = main.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} exists`);
    const next = main.indexOf('\nfunction ', start + 1);
    return main.slice(start, next === -1 ? main.length : next);
  };
  vm.runInContext(`
    ${slice('_validGoogleClientId')}
    ${slice('_validGoogleClientSecret')}
    ${slice('_googleSpreadsheetId')}
    ${slice('_columnLetters')}
    globalThis.api = {
      clientId: v => _validGoogleClientId(v),
      secret: v => _validGoogleClientSecret(v),
      sheetId: v => _googleSpreadsheetId(v),
      columns: n => _columnLetters(n),
    };
  `, context);
  return context.api;
}

test('MB161-016: the Google scope is spreadsheets, and nothing wider', () => {
  // Two-way sync needs write access, so the readonly scope is gone. What must
  // NOT creep back is anything broader — Drive would hand over every file in
  // the account, not just the sheets somebody chose to link.
  assert.match(main, /const GOOGLE_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/spreadsheets'/);
  assert.doesNotMatch(main, /auth\/drive/, 'Drive scope is never requested');
  assert.doesNotMatch(main, /auth\/spreadsheets\.readonly/,
    'and the old readonly scope is gone, so a stale grant cannot silently persist');
  // The scope Google GRANTED is still verified, not the one asked for.
  const complete = main.slice(main.indexOf("_secureHandle('google-oauth-complete'"));
  assert.match(complete, /granted\.split\(\/\\s\+\/\)\.includes\(GOOGLE_SCOPE\)/);
});

test('MB161-016: a push re-reads its targets and refuses anything that moved', () => {
  const push = main.slice(main.indexOf("_secureHandle('google-sheet-push'"),
                          main.indexOf('function _columnLetters'));
  // The whole safety argument lives in this ordering: read, compare, then
  // write only what still matches.
  assert.ok(push.indexOf('values:batchGet') < push.indexOf('values:batchUpdate'),
    'the current values are fetched BEFORE anything is written');
  assert.match(push, /if \(now !== cell\.expected\)/,
    'a cell that changed in Google since the app last looked is not written');
  assert.match(push, /skipped\.push\(/, 'it is reported instead, so it can become a conflict');
  assert.match(push, /replaced\.push\(\{ a1: cell\.a1, previous: now, next: cell\.value \}\)/,
    'and every value actually overwritten is returned, so a copy survives');
  assert.match(push, /valueInputOption: 'RAW'/,
    'RAW: Google stores text as given rather than reinterpreting it');
  assert.match(push, /if \(!toWrite\.length\) return/,
    'nothing to write means no request at all');
});

test('MB161-016: the push is bounded and validates every target cell', () => {
  const push = main.slice(main.indexOf("_secureHandle('google-sheet-push'"),
                          main.indexOf('function _columnLetters'));
  assert.match(push, /request\.cells\.length > 5000/, 'a runaway push is refused');
  assert.match(push, /\^\[A-Z\]\{1,3\}\[1-9\]\[0-9\]\{0,3\}\$/,
    'every A1 reference is validated rather than interpolated into a range');
  assert.match(push, /_requireAppRole\(COMMUNICATION_ROLES\)/);
  // batchUpdate must appear exactly once: the push handler and nowhere else.
  assert.equal(main.split('values:batchUpdate').length - 1, 1,
    'there is exactly one place in main.js that writes to Google');
});

test('MB161-016: the preload bridge exposes read and push, and no more', () => {
  const start = preload.indexOf("exposeInMainWorld('electronGoogleSheets'");
  assert.notEqual(start, -1);
  const bridge = preload.slice(start, preload.indexOf('});', start));
  assert.match(bridge, /read:\s*\(request\)/);
  assert.match(bridge, /push:\s*\(request\)/);
  for (const method of ['delete', 'clear', 'append', 'createSheet', 'format']) {
    assert.doesNotMatch(bridge, new RegExp(`\\b${method}\\s*:`),
      `the bridge must not offer ${method}`);
  }
  // Tokens still never cross into the renderer.
  assert.doesNotMatch(bridge, /token|refresh|secret/i);
});

test('MB161-014: connecting and configuring are Owner-only', () => {
  for (const channel of ['google-set-credentials', 'google-oauth-begin',
                         'google-oauth-complete', 'google-disconnect']) {
    const start = main.indexOf(`_secureHandle('${channel}'`);
    assert.notEqual(start, -1, `${channel} is handled`);
    const body = main.slice(start, start + 400);
    assert.match(body, /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
      `${channel} must be Owner-only — linking a Google account is a privileged act`);
  }
  // Reading is not: staff who can see spreadsheets can see the linked values.
  const read = main.slice(main.indexOf("_secureHandle('google-sheet-read'"));
  assert.match(read.slice(0, 300), /_requireAppRole\(COMMUNICATION_ROLES\)/);
});

test('MB161-014: a client id must really be a Google client id', () => {
  const api = googleHelpers();
  assert.equal(api.clientId('123456789012-abc123def456.apps.googleusercontent.com'), true);
  for (const bad of [
    '', 'not-an-id', '123.apps.googleusercontent.com',
    '123456789012-abc.apps.googleusercontent.com.evil.com',
    'https://123456789012-abc123def456.apps.googleusercontent.com',
    '123456789012-abc123def456.apps.googleuser.com', null, undefined, 42,
  ]) {
    assert.equal(api.clientId(bad), false, `${String(bad)} must be refused`);
  }
});

test('MB161-014: a spreadsheet link is parsed, never guessed at', () => {
  const api = googleHelpers();
  const id = '1zZ4M7ewY7cFBePc2nV-kX2j-YHr0riIPQ6bFvB7WYrg';
  assert.equal(api.sheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), id);
  assert.equal(api.sheetId(`https://docs.google.com/spreadsheets/d/${id}`), id);
  assert.equal(api.sheetId(id), id, 'a bare id is accepted too');

  for (const bad of [
    '', 'https://evil.com/spreadsheets/d/' + id,
    'https://docs.google.com.evil.com/spreadsheets/d/' + id,
    'http://docs.google.com/spreadsheets/d/' + id,   // plain http
    'https://docs.google.com/document/d/' + id,      // a Doc, not a Sheet
    'javascript:alert(1)', null, undefined,
  ]) {
    assert.equal(api.sheetId(bad), null,
      `${String(bad)} must not resolve to a spreadsheet — reading the wrong sheet silently is worse than refusing`);
  }
});

test('MB161-014: the A1 range is bounded and correct', () => {
  const api = googleHelpers();
  assert.equal(api.columns(1), 'A');
  assert.equal(api.columns(26), 'Z');
  assert.equal(api.columns(27), 'AA');
  assert.equal(api.columns(30), 'AD');
  assert.equal(api.columns(100), 'CV');
  // The read handler clamps before building the range.
  const read = main.slice(main.indexOf("_secureHandle('google-sheet-read'"));
  assert.match(read, /Math\.min\(Math\.max\(Number\(request\.rows\) \|\| 200, 1\), 500\)/);
  assert.match(read, /Math\.min\(Math\.max\(Number\(request\.columns\) \|\| 30, 1\), 100\)/);
  assert.match(read, /A1:\$\{_columnLetters\(columns\)\}\$\{rows\}/,
    'never the whole tab — Google tabs carry thousands of empty default rows');
});

test('MB161-014: the OAuth flow keeps the code in main and demands a refresh token', () => {
  const begin = main.slice(main.indexOf('async function _beginGoogleOAuth'));
  assert.match(begin, /access_type: 'offline'/,
    'without this Google issues no refresh token and the link dies within the hour');
  assert.match(begin, /prompt: 'consent'/);
  assert.match(begin, /code_challenge_method: 'S256'/, 'PKCE, same as the Microsoft flow');
  assert.match(begin, /http:\/\/127\.0\.0\.1:\$\{address\.port\}/,
    'Google matches loopback on the IP literal, not on localhost');
  assert.match(begin, /_safeRendererSend\('google-auth-code', \{ state: pendingGoogleOAuth\.state \}\)/,
    'the renderer receives the state only; the authorization code stays in main');

  const complete = main.slice(main.indexOf("_secureHandle('google-oauth-complete'"));
  assert.match(complete, /verifierChallenge !== attempt\.codeChallenge/, 'the PKCE verifier is checked');
  assert.match(complete, /tokens\.refresh_token !== 'string'/,
    'a grant with no refresh token is refused rather than silently expiring later');
  assert.match(complete, /granted\.split\(\/\\s\+\/\)\.includes\(GOOGLE_SCOPE\)/,
    'the scope Google actually granted is verified, not the one we asked for');
});

test('MB161-014: access tokens are memory-only and errors say what to do', () => {
  assert.match(main, /Access tokens live in memory only/);
  assert.doesNotMatch(main, /accessToken:\s*tokens\.access_token[\s\S]{0,80}_saveGoogleVault/,
    'an access token is never written to the vault');
  const failure = main.slice(main.indexOf('function _googleReadFailure'));
  for (const [code, hint] of [[401, /Disconnect and reconnect/], [403, /Sheets API is not enabled/],
                              [404, /shared with the connected account/], [429, /rate limiting/]]) {
    assert.match(failure, hint, `HTTP ${code} explains itself`);
  }
});

test('MB161-017: every Google call uses Electron net, not Node https', () => {
  // Node ships its own CA bundle and ignores the macOS keychain, so on a Mac
  // running TLS-inspecting software (Qustodio, corporate filtering, some
  // antivirus) every Node https request dies with "unable to verify the first
  // certificate" while the same request from a browser succeeds. Reported from
  // a real machine. Electron's net uses Chromium's stack, which reads the
  // system trust store — the certificate is still verified, against the store
  // that reflects the actual machine.
  const googleStart = main.indexOf('function _googleHttp');
  assert.notEqual(googleStart, -1, '_googleHttp exists');
  const helper = main.slice(googleStart, main.indexOf('async function _googleTokenRequest'));
  assert.match(helper, /const \{ net \} = require\('electron'\)/);
  assert.match(helper, /net\.request\(\{ method, url \}\)/);

  // No Google-facing function may fall back to Node https.
  for (const [name, endMarker] of [
    ['async function _googleTokenRequest', 'async function _googleApiGet'],
    ['async function _googleApiGet', 'async function _googleAccountEmail'],
  ]) {
    const start = main.indexOf(name);
    assert.notEqual(start, -1, `${name} exists`);
    const body = main.slice(start, main.indexOf(endMarker, start + 1));
    assert.doesNotMatch(body, /https\.request/, `${name} must not use Node https`);
  }
  const push = main.slice(main.indexOf("_secureHandle('google-sheet-push'"),
                          main.indexOf('function _columnLetters'));
  assert.doesNotMatch(push, /https\.request/, 'the push must not use Node https either');
  assert.match(push, /_googleHttp\(\{/, 'it goes through the shared helper');

  // The helper still bounds size and time; swapping transports must not have
  // dropped either.
  assert.match(helper, /size > limit/);
  assert.match(helper, /Google did not respond in time/);
  assert.match(helper, /request\.abort\(\)/);
});

test('MB161-018: a tab name is quoted into the A1 range, everywhere', () => {
  // `Monday!A1` parses, which is why this survived testing: every tab in the
  // sheet under test had a one-word name. A1 requires the sheet name quoted as
  // soon as it contains a space or punctuation, so "Color Block" or "Week 1"
  // returned a parse error — and on an all-tabs import one such tab took the
  // whole batch down with it.
  assert.match(main, /function _googleRange\(title, cells\)/);
  const helper = main.slice(main.indexOf('function _googleRange'),
                            main.indexOf('function _columnLetters'));
  assert.match(helper, /replace\(\/'\/g, "''"\)/,
    "an internal quote is escaped by doubling, which is the escape A1 defines");

  // No range may be built by interpolating a bare title again.
  assert.doesNotMatch(main, /`\$\{title\}!/,
    'every range goes through the helper');
  for (const built of [
    /const range = _googleRange\(title, `A1:\$\{_columnLetters\(columns\)\}\$\{rows\}`\)/,
    /_googleRange\(title, a1\)/,
    /range: _googleRange\(title, cell\.a1\)/,
  ]) assert.match(main, built);
});

test('MB161-018: the formatted read stays bounded and trims to what is used', () => {
  const read = main.slice(main.indexOf("_secureHandle('google-sheet-read'"),
                          main.indexOf('function _googleColorHex'));
  // A fields mask is not an optimisation here. Without it Google returns every
  // format property of every cell and a 500x100 window runs to tens of
  // megabytes, which is a memory problem rather than a slow one.
  assert.match(read, /includeGridData=true&fields=/);
  assert.match(read, /48 \* 1024 \* 1024/, 'and the response is still capped');

  // Google reports an effective format for every cell in the requested window
  // whether or not anybody touched it, so without trimming every import would
  // arrive as the full 500 rows of nothing.
  assert.match(read, /const usedRows = lastRow \+ 1/);
  assert.match(read, /const usedCols = lastCol \+ 1/);
  assert.match(read, /merges\.length >= 5000/, 'and the merge list is bounded too');
});

test('MB161-018: white and black map to "no colour", not to a fill', () => {
  // Google reports white for an unformatted cell and black for default text.
  // Storing those as explicit colours would turn a blank tab into fifty
  // thousand white cells and defeat the trimming above.
  const context = { Object, Array, Number, String, Math };
  vm.runInNewContext(
    `${extractFunction(main, '_isPlainObject')}
     ${extractFunction(main, '_googleColorHex')}
     this.api = (color, blank) => _googleColorHex(color, blank);`, context);
  const bg = color => context.api(color, '#ffffff');
  const fg = color => context.api(color, '#000000');

  assert.equal(bg({ red: 1, green: 1, blue: 1 }), '', 'white background is no fill');
  assert.equal(fg({}), '', 'a missing channel is zero, so {} is black text: no colour');
  assert.equal(bg({}), '#000000', 'but {} as a background really is black');
  assert.equal(bg({ red: 0.8, green: 0.8, blue: 0.8 }), '#cccccc');
  assert.equal(bg({ red: 1, green: 1, blue: 0 }), '#ffff00');
  // Junk must not become a colour string that then reaches CSS.
  for (const junk of [null, undefined, 'red', 42, []]) assert.equal(bg(junk), '');
  // Out-of-range floats are clamped rather than producing '#1ff00-8'.
  assert.equal(bg({ red: 2, green: -1, blue: 0.5 }), '#ff0080');
});
