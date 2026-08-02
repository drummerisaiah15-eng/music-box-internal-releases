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

// --- V159-006: Step Up authorization lives in the trusted layer --------------

test('V159-006: Step Up requires both a privileged role and an unexpired grant', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const guard = main.slice(main.indexOf('function _requireStepUpGrant('));
  const body = guard.slice(0, guard.indexOf('\n}\n') + 3);

  assert.match(body, /_requireAppRole\(STEP_UP_ROLES\)/,
    'role is enforced in main, not inferred from a renderer display name');
  assert.match(body, /Date\.now\(\) >= stepUpGrant\.expiresAt/, 'grants expire');
  assert.match(body, /stepUpGrant\.name !== session\.name/,
    'a grant cannot be reused across profiles');
  assert.match(body, /stepUpGrant\.webContentsId !== mainWindow\.webContents\.id/,
    'a grant is bound to the live window');
  assert.match(main, /const STEP_UP_ROLES = new Set\(\['Owner', 'Operations & Events'\]\)/,
    'Front Desk profiles can never hold a Step Up grant');
});

test('V159-006: a Step Up grant cannot outlive its session', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const fn of ['_resetAppSession', '_setAppSession']) {
    const start = main.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1, `${fn} exists`);
    const body = main.slice(start, main.indexOf('\n}', start));
    assert.match(body, /_resetStepUpGrant\(\)/,
      `${fn} clears any Step Up grant (logout, switch, expiry)`);
  }
});

test('V159-006: enrolment is owner-only and rejects unprivileged profiles', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("_secureHandle('step-up-enroll'");
  assert.notEqual(start, -1, 'the enrolment handler exists');
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'only the owner may enrol a Step Up passcode');
  assert.match(body, /STEP_UP_ROLES\.has\(role\)/,
    'a Front Desk profile cannot be given Step Up credentials');
  assert.match(body, /_validOwnerPin\(request\.passcode, false\)/,
    'the passcode must be a full 6 digits');
  assert.match(body, /_buildOwnerVerifier\(request\.passcode\)/,
    'the passcode is stored as a PBKDF2 verifier, never in plaintext');
});

test('V159-006: authentication is rate limited and never self-enrols', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("_secureHandle('step-up-authenticate'");
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /Date\.now\(\) < stepUpLockedUntil/, 'lockout is honoured');
  assert.match(body, /_recordStepUpFailure\(\)/, 'failures are counted');
  assert.match(body, /_ownerPinMatches\(passcode, record\)/, 'constant-time verifier compare');
  assert.match(body, /No Step Up passcode is enrolled/,
    'an unenrolled profile cannot be claimed by whoever reaches the Mac first');
  assert.doesNotMatch(body, /_buildOwnerVerifier/,
    'authenticating must never create a credential');
});

test('V159-006: the renderer cannot grant itself Step Up access', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /stepUpAuthenticate:\(passcode\) => ipcRenderer\.invoke\('step-up-authenticate', passcode\)/,
    'the renderer can only submit a passcode for main to verify');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // The cached flag is explicitly documented as advisory.
  assert.match(renderer, /_stepUpTrusted/, 'renderer keeps only a mirrored status');
  assert.match(renderer, /main re-checks the role AND the grant on every sensitive operation/,
    'the cached value is documented as non-authoritative');
});
