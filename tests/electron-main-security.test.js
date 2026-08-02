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
  const start = source.indexOf(`function ${name}(`);
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
