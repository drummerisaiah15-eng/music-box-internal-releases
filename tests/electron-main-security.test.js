const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
    /_secureHandle\('app-session-start-staff'[\s\S]*const role = _roleForAppProfile\(requested\)[\s\S]*!role \|\| role === 'Owner'\) throw/
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
  // MB1188-060: a custom entry carrying a BUILT-IN name is DROPPED, not fatal.
  //
  // This used to throw, and throwing is what bricked a Mac: the duplicate check
  // on add reads _allAppProfiles(), which excludes removed built-ins, so
  // "Ana Chaves" could be added after Ana had been removed — and from then on
  // every read of the vault threw, which is list-profiles, start-staff, add,
  // remove and export-directory. No staff could sign in. The built-in is
  // authoritative, so there is nothing in the custom entry worth preserving,
  // and dropping it heals a vault an older build already poisoned.
  assert.deepEqual(JSON.parse(JSON.stringify(profilesFromVault({
    app_staff_profiles_v1: [{ name: 'Ana Chaves', role: 'Front Desk', createdAt: 1 }],
  }))), []);
  // A genuine duplicate among CUSTOM entries is still fatal.
  assert.throws(() => profilesFromVault({
    app_staff_profiles_v1: [
      { name: 'Dana Reed', role: 'Front Desk', createdAt: 1 },
      { name: 'dana  reed', role: 'Front Desk', createdAt: 2 },
    ],
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

test('MB161-029: importing a spreadsheet FILE is gone, recovery export is not', () => {
  // The studio brings sheets in from Google, so the file path was a second way
  // to do the same job that nobody used — and it was the larger attack surface
  // of the two: a file dialog, a path realpath'd and stat'd, and an untrusted
  // .xlsx parsed in a utility process. Asserted as absence, since that is the
  // property that regresses quietly.
  for (const gone of [
    "_secureHandle('import-spreadsheet'", '_parseSpreadsheetInUtility',
    'MAX_SPREADSHEET_SOURCE_BYTES', 'Music Box Spreadsheet Parser',
    'Spreadsheet import timed out',
  ]) {
    assert.ok(!main.includes(gone), `main.js must not contain ${gone}`);
  }
  assert.ok(!preload.includes("invoke('import-spreadsheet')"),
    'and the bridge does not offer it');
  // The parser it forked is no longer shipped at all.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'spreadsheet-worker.js')),
    'the worker file is deleted');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!pkg.build.files.includes('spreadsheet-worker.js'),
    'and is not listed for packaging');

  // Exporting a recovery bundle is a different thing and must survive: it is
  // the only way out of a quarantined workbook.
  assert.match(main, /_secureHandle\('export-spreadsheet-recovery'/);
  assert.match(main, /MAX_SPREADSHEET_RECOVERY_BYTES = 8 \* 1024 \* 1024/);
  assert.match(main, /await _atomicWriteFile\(destination, contents, 0o600\)/);
  assert.match(preload, /exposeInMainWorld\('electronSpreadsheet'/);
  assert.match(preload, /ipcRenderer\.invoke\('export-spreadsheet-recovery', contents\)/);

  // The PDF parser still forks a utility process; only the spreadsheet one went.
  assert.match(main, /Music Box PDF Parser/);
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
    const ASSIGNABLE_PROFILE_ROLES = Object.freeze(['Operations Manager', 'Operations & Events', 'Front Desk']);
    // MB161-031: the harness runs the real handler bodies, so it needs the real
    // role set and the real Owner guard rather than stubs of them.
    const OPERATIONS_MANAGER_ROLES = new Set(['Owner', 'Operations Manager']);
    const _appSessionHasRole = allowed => !!appSession && allowed.has(appSession.role);
    ${sliceFunction(main, '_requireNotOwnerTarget')}
    ${sliceFunction(main, '_requireRemovableProfileTarget')}
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
    const _buildStaffDirectory = () => [];
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

test('P1-1: Operations Manager has removal-only authority over ordinary roles', async () => {
  const vault = {
    app_staff_profiles_v1: [
      { name: 'Megan', role: 'Front Desk', createdAt: 1 },
      { name: 'Dana Front', role: 'Front Desk', createdAt: 2 },
      { name: 'Owen Events', role: 'Front Desk', createdAt: 3 },
      { name: 'Morgan Manager', role: 'Front Desk', createdAt: 4 },
    ],
    app_profile_roles_v1: {
      Megan: 'Operations Manager',
      'Owen Events': 'Operations & Events',
      'Morgan Manager': 'Operations Manager',
    },
  };
  const manager = removalHarness({ role: 'Operations Manager', signedInAs: 'Megan', vault });
  assert.equal((await manager.api.remove('Dana Front')).ok, true);
  assert.equal((await manager.api.remove('Owen Events')).ok, true);
  await assert.rejects(() => manager.api.remove('Morgan Manager'), /cannot remove an Owner or Operations Manager/);
  await assert.rejects(() => manager.api.remove('Elizabeth Chaves'), /cannot remove an Owner or Operations Manager/);
  await assert.rejects(() => manager.api.remove('Megan'), /currently signed in/);

  const owner = removalHarness({ role: 'Owner', signedInAs: 'Elizabeth Chaves', vault });
  assert.equal((await owner.api.remove('Morgan Manager')).ok, true,
    'Owner retains authority over Operations Manager profiles');

  const staff = removalHarness({ role: 'Front Desk', signedInAs: 'Ana Chaves', vault });
  await assert.rejects(() => staff.api.remove('Dana Front'), /not authorized/);
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
    const ASSIGNABLE_PROFILE_ROLES = Object.freeze(['Operations Manager', 'Operations & Events', 'Front Desk']);
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
    ${sliceFunction(main, '_mergeDirectoryEntries')}
    ${sliceFunction(main, '_buildStaffDirectory')}
    ${sliceFunction(main, '_validDirectoryEntry')}
    ${sliceFunction(main, '_applyLoginDirectoryAdditions')}
    ${sliceFunction(main, '_applyStaffDirectory')}
    ${main.slice(main.indexOf('const PROFILE_ROLE_RANK'), main.indexOf('function _profileRoleOverrides'))}
    // MB1188-081: the real IPC handler body, so a two-Mac exchange can be
    // driven end to end rather than asserted from source.
    globalThis.importDirectory = directory => {
      const deferred = [];
      const profiles = _applyStaffDirectory(directory, {
        elevate: appSession ? new Set(['Owner']).has(appSession.role) : false,
        deferred,
      });
      return { ok: true, profiles, deferred, applied: deferred.length === 0 };
    };
    globalThis.roleOf = name => _roleForAppProfile(name);
    globalThis.build = () => _buildStaffDirectory();
    // MB1188-073: these harness cases are the OWNER publishing/importing, which
    // is the path that may still set roles. The non-elevating path has its own
    // tests below.
    globalThis.apply = (d, opts = { elevate: true }) => _applyStaffDirectory(d, opts);
    globalThis.applyBeforeLogin = d => _applyLoginDirectoryAdditions(d);
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

test('directory: a cold login screen adds new profiles without granting roles or applying removals', () => {
  const target = directoryHarness({ vault: {} });
  const result = target.api.applyBeforeLogin([
    { id: 'profile:elizabeth chaves', name: 'Elizabeth Chaves', role: 'Owner', builtIn: true },
    { id: 'profile:carrie gass', name: 'Carrie Gass', role: 'Operations & Events', builtIn: true },
    { id: 'profile:emma minnetto', name: 'Emma Minnetto', role: 'Front Desk', builtIn: true,
      _deleted: true },
    { id: 'profile:kylie', name: 'Kylie', role: 'Front Desk', builtIn: false },
    { id: 'profile:megan', name: 'Megan', role: 'Operations Manager', builtIn: false },
  ]);

  const profiles = [...target.api.profiles()];
  assert.ok(profiles.includes('Kylie:Front Desk'),
    'a new ordinary profile becomes available at the receiving login screen');
  assert.ok(profiles.includes('Megan:Front Desk'),
    'a cold-start import never grants the requested elevated role');
  assert.ok(profiles.includes('Emma Minnetto:Front Desk'),
    'signed-out synchronization never removes a login');
  assert.ok(profiles.includes('Carrie Gass:Operations & Events'),
    'an existing role is not rewritten before authentication');
  assert.deepEqual(
    Array.from(result.deferred, entry => `${entry.name}:${entry.reason}`).sort(),
    ['Emma Minnetto:removal', 'Megan:role'].sort(),
    'authority-changing work is explicitly deferred for the authenticated importer',
  );

  const saved = target.state.savedTimes;
  target.api.applyBeforeLogin([
    { id: 'profile:kylie', name: 'Kylie', role: 'Front Desk', builtIn: false },
  ]);
  assert.equal(target.state.savedTimes, saved, 'replaying the same login addition is idempotent');
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
  // MB1188-029 widened this and was reverted. The reason is asserted below, so
  // that reinstating it means confronting the reason rather than rediscovering
  // it: a published directory REBUILDS the receiving vault, so a stale
  // publisher deletes rather than merely failing to add.
  const exportBody = extractHandlerBody(main, 'app-session-export-directory');
  assert.match(exportBody, /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'only the owner publishes');
  const apply = main.slice(main.indexOf('function _applyStaffDirectory'),
                           main.indexOf("_secureHandle('app-session-export-directory'"));
  assert.match(apply, /vault\[STAFF_PROFILES_VAULT_KEY\] = custom/,
    'import REPLACES the custom profile list — absence really is deletion here');
  assert.match(apply, /else delete vault\[PROFILE_ROLE_OVERRIDES_VAULT_KEY\]/,
    'and an absent role override is a demotion, not a no-op');
  // MB1188-073 broke the escalation chain this warning describes, from both
  // ends: changing a role is Owner-only, and an import performed by anybody
  // other than an Owner cannot raise a role at all. Removal stays with the
  // Operations Manager — it is onboarding work, not privilege.
  const removeBody = main.slice(main.indexOf("_secureHandle('app-session-remove-staff-profile'"));
  assert.match(removeBody.slice(0, 200), /_requireAppRole\(OPERATIONS_MANAGER_ROLES\)/,
    'removal is still Operations-Manager-gated');
  const roleBody = main.slice(main.indexOf("_secureHandle('app-session-set-profile-role'"));
  assert.match(roleBody.slice(0, 300), /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'granting a role is Owner-only');
  assert.match(main, /ASSIGNABLE_PROFILE_ROLES = Object\.freeze\(\['Operations Manager'/,
    'Operations Manager is still grantable by an OWNER import, so it is not a trust root');
  const importBody = extractHandlerBody(main, 'app-session-import-directory');
  assert.match(importBody, /_applyStaffDirectory\(directory, \{/,
    'import runs through the validating applier, not a raw vault write');
  assert.match(importBody, /elevate: _appSessionHasRole\(new Set\(\['Owner'\]\)\)/,
    'and only an Owner session lets that import raise anybody');
  assert.match(preload,
    /exportDirectory:\s+\(\) => ipcRenderer\.invoke\('app-session-export-directory'\)/);
  assert.match(preload,
    /importDirectory:\s+\(directory\) => ipcRenderer\.invoke\('app-session-import-directory', directory\)/);
  assert.match(preload,
    /importLoginDirectory:\s+\(directory\) => ipcRenderer\.invoke\('app-login-import-directory', directory\)/);

  const loginImportBody = extractHandlerBody(main, 'app-login-import-directory');
  assert.match(loginImportBody, /_applyLoginDirectoryAdditions\(directory\)/,
    'the signed-out channel uses the addition-only importer');
  assert.doesNotMatch(loginImportBody, /_applyStaffDirectory|_requireAppRole/,
    'it cannot reach the role/removal importer and does not require an impossible login session');

  const loginConfigBody = extractHandlerBody(main, 'firebase-login-directory-config');
  assert.match(loginConfigBody, /apiKey: config\.apiKey/);
  assert.match(loginConfigBody, /projectId: config\.projectId/);
  assert.doesNotMatch(loginConfigBody, /password:\s*config\.password/,
    'pre-login synchronization never releases the Firebase password');
  assert.match(preload,
    /loginDirectoryConfig:\s+\(\) => ipcRenderer\.invoke\('firebase-login-directory-config'\)/);
});

test('directory: the renderer publishes on every profile change and merges on arrival', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /'staff_directory',/, 'it is a synchronized key');
  assert.match(renderer, /staff_directory: 'tombstoned-record-list'/,
    'two Macs editing different profiles merge instead of clobbering');
  assert.match(renderer, /if \(key === 'staff_directory'\)/, 'arrivals are applied');
  // Assert the intent, not a call count. This used to require exactly three
  // occurrences of `await publishStaffDirectory();` anywhere in the file, which
  // says nothing about WHICH paths publish — and broke the moment a legitimate
  // fourth caller (the pending-publication retry) was added.
  for (const name of ['addLoginUser', 'removeLoginUser', 'setProfileRole']) {
    const start = renderer.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} exists`);
    const body = renderer.slice(start, renderer.indexOf('\n}\n', start) + 2);
    if (name === 'removeLoginUser') {
      assert.match(body, /_persistAuthorizedDirectorySnapshot\(result\.directory\)/,
        'removal publishes the exact main-authorized tombstone snapshot');
    } else {
      assert.match(body, /publishStaffDirectory\(\)/, `${name} publishes the directory`);
    }
  }
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
    // _atomicWriteFile names its temp file with the pid; without this it throws
    // and the sequence counter silently falls back to rebuilding from disk.
    process,
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
    ${sliceFunction(main, '_atomicWriteFile')}
    ${sliceFunction(main, '_nextSnapshotSequence')}
    ${sliceFunction(main, '_listBackupSnapshots')}
    ${sliceFunction(main, '_pruneBackupSnapshots')}
    ${sliceFunction(main, '_readBackupCandidate')}
    globalThis.api = {
      // MB1188-014: the sequence sits between the device and the timestamp.
      name: (d, when, seq = 0) => _snapshotFileName(d, seq, when),
      list: () => _listBackupSnapshots(),
      prune: async () => _pruneBackupSnapshots(await _listBackupSnapshots()),
      read: () => _readBackupCandidate(),
      deviceId: () => _backupDeviceId(),
      nextSeq: async d => _nextSnapshotSequence(d, await _listBackupSnapshots()),
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
  // MB161-045: the intent is "any signed-in profile", and this used to assert a
  // hand-written list of the roles that existed at the time. When Operations
  // Manager was added, the literal silently excluded it — and the test, by
  // pinning the literal, made sure it stayed excluded. Assert the set, which is
  // what the sentence above actually means.
  assert.match(body, /_requireAppRole\(COMMUNICATION_ROLES\)/);
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

test('MB161-021: the Google scope is readonly, and nothing wider', () => {
  // Two-way sync existed and was removed. Narrowing the scope back is the whole
  // point of having removed it: Google now refuses a write regardless of what
  // this codebase does, which is a guarantee no amount of care in main.js can
  // match. Widening it again should have to be a deliberate, visible act.
  assert.match(main, /const GOOGLE_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/spreadsheets\.readonly'/);
  assert.doesNotMatch(main, /auth\/drive/, 'Drive scope is never requested');
  // The scope Google GRANTED is still verified, not the one asked for.
  const complete = main.slice(main.indexOf("_secureHandle('google-oauth-complete'"));
  assert.match(complete, /granted\.split\(\/\\s\+\/\)\.includes\(GOOGLE_SCOPE\)/);
});

test('MB161-021: there is no write path to Google at all', () => {
  // Stated as absence rather than as "the write is careful", because absence is
  // the property that cannot regress quietly. Anything here reappearing means
  // the app can modify somebody's spreadsheet again.
  for (const writer of [
    'values:batchUpdate', 'values:append', 'values:clear',
    'batchUpdate', 'valueInputOption', 'USER_ENTERED',
    'google-sheet-push',
  ]) {
    assert.ok(!main.includes(writer),
      `main.js must not contain ${writer} — that is a write to somebody's sheet`);
  }
  // And nothing anywhere in main POSTs to the Sheets API. Checked against the
  // host rather than by slicing out "the Google section", because that slice
  // ran on into Microsoft and RingCentral and counted their POSTs — a test that
  // fails for the wrong reason teaches people to edit the test.
  const sheetsRequests = [...main.matchAll(/sheets\.googleapis\.com[^`'"]*/g)].map(m => m[0]);
  assert.ok(sheetsRequests.length, 'the Sheets API is still used for reads');
  for (const url of sheetsRequests) {
    assert.doesNotMatch(url, /:(batchUpdate|append|clear)/, `${url} is not a read`);
  }
  // The only POST to Google at all is the token exchange, and it goes to the
  // OAuth endpoint rather than to anybody's spreadsheet.
  for (const [, target] of main.matchAll(/method: 'POST',[\s\S]{0,200}?url: ([^,\n]+)/g)) {
    assert.doesNotMatch(target, /sheets\.googleapis\.com/, 'nothing POSTs to the Sheets API');
  }
  assert.match(main, /GOOGLE_TOKEN_ENDPOINT = 'https:\/\/oauth2\.googleapis\.com\/token'/,
    'the token exchange still points where it should');
});

test('MB161-021: the preload bridge exposes reads, and no writer', () => {
  const start = preload.indexOf("exposeInMainWorld('electronGoogleSheets'");
  assert.notEqual(start, -1);
  const bridge = preload.slice(start, preload.indexOf('});', start));
  assert.match(bridge, /read:\s*\(request\)/);
  assert.match(bridge, /describe:\s*\(request\)/);
  for (const method of ['push', 'write', 'delete', 'clear', 'append', 'createSheet', 'format']) {
    assert.doesNotMatch(bridge, new RegExp(`\\b${method}\\s*:`),
      `the bridge must not offer ${method}`);
  }
});

test('MB161-031: connecting Google needs Owner or Operations Manager, not staff', () => {
  // Was Owner-only. Connecting a Google account is running the studio rather
  // than owning it, so an Operations Manager can do it too — but it is still a
  // privileged act and Front Desk must never reach it.
  for (const channel of ['google-set-credentials', 'google-oauth-begin',
                         'google-oauth-complete', 'google-disconnect']) {
    const start = main.indexOf(`_secureHandle('${channel}'`);
    assert.notEqual(start, -1, `${channel} is handled`);
    const body = main.slice(start, start + 400);
    assert.match(body, /_requireAppRole\(OPERATIONS_MANAGER_ROLES\)/,
      `${channel} is limited to Owner and Operations Manager`);
    assert.doesNotMatch(body, /COMMUNICATION_ROLES/,
      `${channel} must not be open to every signed-in profile`);
  }
  assert.match(main, /OPERATIONS_MANAGER_ROLES = new Set\(\['Owner', 'Operations Manager'\]\)/,
    'and that set is exactly those two roles');
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
  // The push that used to be checked here is gone (MB161-021). What remains is
  // that no Google-facing code anywhere reaches for Node https.
  const googleFns = ['_googleTokenRequest', '_googleApiGet', '_googleAccountEmail'];
  for (const name of googleFns) {
    assert.ok(main.includes(name), `${name} still exists`);
  }
  assert.match(main, /_googleHttp\(\{/, 'everything goes through the shared helper');

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
  // Only the read builds a range now that the write path is gone.
  assert.match(main,
    /const range = _googleRange\(title, `A1:\$\{_columnLetters\(columns\)\}\$\{rows\}`\)/);
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
     this.api = (style, legacy, blank) => _googleColorHex(style, legacy, blank);`, context);
  const bg = color => context.api(null, color, '#ffffff');
  const fg = color => context.api(null, color, '#000000');

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

test('MB161-021: removing the write path took its RAW/USER_ENTERED split with it', () => {
  // While the app could write, a ticked checkbox had to go out as USER_ENTERED
  // (RAW would have stored the string "TRUE" and failed Google's own boolean
  // validation) while everything else stayed RAW so a leading `=` could not
  // become a formula. That whole balancing act is gone with the writes, and
  // must not come back without the scope change that would justify it.
  assert.ok(!main.includes('USER_ENTERED'));
  assert.ok(!main.includes('valueInputOption'));
  // Checkboxes are still READ, which is the half that survived.
  assert.match(main, /cell\.dataValidation\?\.condition\?\.type === 'BOOLEAN'/);
});

test('MB161-020: the read asks Google for the validation that draws the box', () => {
  const read = main.slice(main.indexOf("_secureHandle('google-sheet-read'"),
                          main.indexOf('function _googleColorHex'));
  // A Google checkbox is a validation rule; the cell value is just TRUE/FALSE.
  // Without this in the mask the tick is simply absent from the response, which
  // is why an imported checkbox column arrived reading "FALSE" all the way down.
  // MB1188-032: `values` as well as `type`, because the same rule is also how
  // Google carries a dropdown, and without the options one imports as whatever
  // text happened to be selected.
  assert.match(read, /dataValidation\(condition\(type,values\(userEnteredValue\)\)\)/);
  assert.match(read, /cell\.dataValidation\?\.condition\?\.type === 'BOOLEAN'/);
  assert.match(read, /cell\.dataValidation\?\.condition\?\.type === 'ONE_OF_LIST'/);
  assert.match(read, /formatLine\.push\(options/, 'a dropdown carries its options');
  assert.match(read, /\{ bg, tc, b: bold, cb: checkbox \}/, 'everything else is unchanged');
  // ONE_OF_RANGE points at another range and must NOT be followed: that would
  // be a second read of a range nobody asked for, possibly on another tab.
  // Scanned as a comparison, not as a bare word: the comment in main.js
  // explaining WHY it is not followed contains the name, and a looser pattern
  // fails on the explanation. Third time this codebase has caught someone out
  // that way.
  assert.doesNotMatch(read, /type === 'ONE_OF_RANGE'/);
  // An unticked box is content, so it has to count towards the used extent or
  // an empty checkbox column would be trimmed away entirely. Same for a
  // dropdown nobody has chosen from yet.
  assert.match(read, /bg \|\| tc \|\| bold \|\| checkbox \|\| options/);
});

test('MB161-022: the newer colourStyle wins over the deprecated colour field', () => {
  // Google reports the same colour two ways. `backgroundColor` is deprecated and
  // `backgroundColorStyle` "takes precedence" per the reference. Reading only
  // the deprecated one is how a sheet coloured by conditional formatting or by
  // the document theme could import as plain white.
  const context = { Object, Array, Number, String, Math };
  vm.runInNewContext(
    `${extractFunction(main, '_isPlainObject')}
     ${extractFunction(main, '_googleColorHex')}
     this.api = (style, legacy) => _googleColorHex(style, legacy, '#ffffff');`, context);

  // Both present and disagreeing: the style is the truth.
  assert.equal(
    context.api({ rgbColor: { red: 1, green: 0, blue: 0 } }, { red: 0, green: 0, blue: 1 }),
    '#ff0000');
  // Style present but naming a theme colour, which has no rgb to read. The
  // deprecated field is where Google puts the resolved colour, so it is used.
  assert.equal(context.api({ themeColor: 'ACCENT1' }, { red: 0, green: 0, blue: 1 }), '#0000ff');
  // Only the deprecated field, which is the common case for a plain fill.
  assert.equal(context.api(undefined, { red: 0, green: 1, blue: 0 }), '#00ff00');
  // Neither.
  assert.equal(context.api(undefined, undefined), '');
  // White is still "no fill" whichever field carried it.
  assert.equal(context.api({ rgbColor: { red: 1, green: 1, blue: 1 } }, undefined), '');
});

test('MB161-022: both colour representations are actually requested', () => {
  // The precedence logic is worthless if the field mask never asks for the
  // field that wins.
  const read = main.slice(main.indexOf("_secureHandle('google-sheet-read'"),
                          main.indexOf('function _googleColorHex'));
  assert.match(read, /backgroundColor,backgroundColorStyle/);
  assert.match(read, /foregroundColor,foregroundColorStyle/);
});

test('MB161-028: column widths are requested and bounded', () => {
  const read = main.slice(main.indexOf("_secureHandle('google-sheet-read'"),
                          main.indexOf('function _googleColorHex'));
  assert.match(read, /columnMetadata\(pixelSize\)/, 'the mask asks for the real widths');
  assert.match(read, /columnMetadata\.slice\(0, usedCols\)/,
    'and only for the columns actually kept');
  // MB1188-014: this used to assert the clamp's literal text, which is how it
  // came to enforce a floor of 24 that the workbook validator rejected — the
  // test was pinning the bug in place. Run the clamp instead and check what it
  // produces, so the contract is what is protected rather than the phrasing.
  const clampLine = read.split('\n').find(line => line.includes('Number.isFinite(pixels) && pixels > 0'));
  assert.ok(clampLine, 'the pixelSize clamp is present');
  const clamp = new Function('pixels', clampLine.trim());

  // A hidden column is 0 pixels in Google and must stay 0 — both consumers read
  // that as "leave this column alone" rather than collapsing it.
  assert.equal(clamp(0), 0, 'hidden stays hidden');
  assert.equal(clamp(undefined), 0, 'and so does a missing width');
  // Everything else lands inside the range normalizeSpreadsheetWorkbook keeps,
  // which is 40..1000. A pathological width still cannot take over the grid.
  for (const pixels of [1, 23, 24, 39, 40, 100, 600, 5000]) {
    const width = clamp(pixels);
    assert.ok(width >= 40 && width <= 600,
      `${pixels}px clamps into the stored range, got ${width}`);
  }
  assert.equal(clamp(100), 100, 'an ordinary width is passed through untouched');
  assert.match(read, /columnWidths,/, 'and they are returned to the renderer');
});

test('MB161-031: Operations Manager is assignable, and can never reach the Owner', () => {
  // A senior role below Owner. What it can do is administrative; what it must
  // never do is anything touching ownership — enforced in main, because the
  // renderer can be wrong or worked around and this cannot.
  assert.match(main, /ASSIGNABLE_PROFILE_ROLES = Object\.freeze\(\['Operations Manager', 'Operations & Events', 'Front Desk'\]\)/);
  assert.match(main, /OPERATIONS_MANAGER_ROLES = new Set\(\['Owner', 'Operations Manager'\]\)/);
  // Owner is absent from the assignable list, so it cannot be granted at all.
  assert.ok(!/ASSIGNABLE_PROFILE_ROLES = Object\.freeze\(\[[^\]]*'Owner'/.test(main));

  // Removing an Owner or Operations Manager requires actually being an Owner.
  assert.match(main, /function _requireNotOwnerTarget\(target, action\)/);
  assert.match(main, /if \(target\?\.role === 'Owner' && !_appSessionHasRole\(new Set\(\['Owner'\]\)\)\)/);
  for (const handler of ["app-session-set-profile-role"]) {
    const start = main.indexOf(`_secureHandle('${handler}'`);
    const body = main.slice(start, start + 3000);
    assert.match(body, /_requireNotOwnerTarget\(target,/, `${handler} protects Owner profiles`);
  }
  const removeBody = extractHandlerBody(main, 'app-session-remove-staff-profile');
  assert.match(removeBody, /_requireRemovableProfileTarget\(target\)/);
  assert.match(sliceFunction(main, '_requireRemovableProfileTarget'),
    /target\?\.role === 'Owner' \|\| target\?\.role === 'Operations Manager'/);
});

test('MB161-031: the owner keeps everything that is about ownership or secrets', () => {
  // The line is "running the studio" versus "owning it". Profile management and
  // the Google connection moved; the owner passcode, the Firebase configuration
  // and the credential vault did not, because those are how ownership is proved
  // and where the secrets live.
  for (const handler of [
    'app-session-stage-owner-pin', 'app-session-commit-owner-pin',
    'app-session-cancel-owner-pin', 'firebase-configure', 'firebase-clear',
    // Publishing the directory to every Mac stays an owner act.
    'app-session-export-directory',
  ]) {
    const start = main.indexOf(`_secureHandle('${handler}'`);
    assert.notEqual(start, -1, `${handler} exists`);
    const body = main.slice(start, start + 600);
    assert.match(body, /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
      `${handler} stays Owner-only`);
  }
  // And the ones that moved really did move.
  // app-session-add-staff-profile is deliberately absent: it never had a role
  // guard of its own, and adding one here would silently restrict who can add a
  // profile, which nobody asked for. It defaults every new profile to Front Desk
  // regardless of who creates it.
  //
  // MB1188-073 splits what MB161-031 moved. Adding and removing profiles is
  // routine onboarding and stays with the Operations Manager. Changing a ROLE
  // is granting privilege, and went back to the Owner — it is the step that
  // made the import-directory escalation chain worth walking.
  for (const handler of [
    'app-session-remove-staff-profile',
    'google-set-credentials', 'google-oauth-begin', 'google-oauth-complete',
    'google-disconnect',
  ]) {
    const start = main.indexOf(`_secureHandle('${handler}'`);
    const body = main.slice(start, start + 600);
    assert.match(body, /_requireAppRole\(OPERATIONS_MANAGER_ROLES\)/,
      `${handler} is available to an Operations Manager`);
  }
  const roleBody = main.slice(main.indexOf("_secureHandle('app-session-set-profile-role'"));
  assert.match(roleBody.slice(0, 600), /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'changing a role is Owner-only');
});

test('MB161-045: no handler spells out the role list instead of using the set', () => {
  // Three separate hand-written copies of the role list have now silently
  // excluded a newly added role: the Manage Users dropdown, the profile-list
  // validator, and firebase-runtime-config — which left an Operations Manager
  // running local-only, with no sync and a badge that explained nothing.
  //
  // Any handler that means "every signed-in role" must say COMMUNICATION_ROLES.
  const literals = [...main.matchAll(/_requireAppRole\(new Set\(\[([^\]]*)\]\)\)/g)]
    .map(match => match[1].trim());
  for (const literal of literals) {
    assert.equal(literal, "'Owner'",
      `a literal role list is a copy waiting to go stale: [${literal}]`);
  }
  // And the one set that means "everybody" really does include everybody.
  const assignable = main.match(/ASSIGNABLE_PROFILE_ROLES = Object\.freeze\(\[([^\]]*)\]\)/)[1];
  const communication = main.match(/COMMUNICATION_ROLES = new Set\(\[([^\]]*)\]\)/)[1];
  for (const role of assignable.match(/'[^']+'/g)) {
    assert.ok(communication.includes(role),
      `${role} can be assigned but is not in COMMUNICATION_ROLES`);
  }
  assert.match(main, /_secureHandle\('firebase-runtime-config'[\s\S]{0,600}?_requireAppRole\(COMMUNICATION_ROLES\)/);
});

// ── MB1188-014: a wrong clock must not decide what survives ────────────────

test('MB1188-014: a device orders its own snapshots by sequence, not by clock', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  // Same Mac, three backups. Its clock jumps BACKWARDS between them — an NTP
  // correction, a manual date change, the end of daylight saving.
  fs.writeFileSync(path.join(dir, api.name('aaaaaaaaaaaa', new Date(Date.UTC(2026, 7, 1, 12, 0)), 1)),
    JSON.stringify({ which: 'first' }));
  fs.writeFileSync(path.join(dir, api.name('aaaaaaaaaaaa', new Date(Date.UTC(2026, 7, 1, 9, 0)), 2)),
    JSON.stringify({ which: 'second' }));
  fs.writeFileSync(path.join(dir, api.name('aaaaaaaaaaaa', new Date(Date.UTC(2026, 7, 1, 10, 0)), 3)),
    JSON.stringify({ which: 'third' }));
  const listed = [...await api.list()];
  assert.deepEqual(listed.map(entry => entry.sequence), [3, 2, 1],
    'the newest is the highest sequence, whatever the timestamps say');
  const candidate = await api.read();
  assert.equal(candidate.data.which, 'third', 'and that is what a restore reads');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MB1188-014: a snapshot written by an earlier build is still read', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  // No sequence in the name — every backup already in the folder looks like this.
  const legacy = 'sync-cccccccccccc-2026-08-01T10-00-00-000Z.json';
  fs.writeFileSync(path.join(dir, legacy), JSON.stringify({ which: 'legacy' }));
  const listed = [...await api.list()];
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sequence, 0, 'read as sequence zero');
  assert.equal((await api.read()).data.which, 'legacy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MB1188-014: the sequence only ever increases, and survives a lost counter', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  assert.equal(await api.nextSeq('dddddddddddd'), 1, 'first backup on this Mac');
  assert.equal(await api.nextSeq('dddddddddddd'), 2);
  // The counter file is deleted — a reinstall, or a wiped application folder.
  fs.rmSync(path.join(dir, 'icloud-snapshot-seq.json'), { force: true });
  fs.writeFileSync(path.join(dir, api.name('dddddddddddd', new Date(Date.UTC(2026, 7, 1, 10, 0)), 7)),
    JSON.stringify({}));
  assert.equal(await api.nextSeq('dddddddddddd'), 8,
    'the snapshots in the folder are themselves the record of how far it got');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MB1188-014: a Mac with a clock years ahead cannot crowd the others out', async () => {
  const dir = tmpDir();
  const api = snapshotHarness(dir);
  // Four Macs. One of them believes it is 2031, so under timestamp-ordered
  // retention every one of its snapshots sorts ahead of everybody else's.
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(
      path.join(dir, api.name('feeeeeeeeeee', new Date(Date.UTC(2031, 0, 1, 10, i)), i + 1)),
      JSON.stringify({ from: 'future' }));
  }
  for (const device of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(dir, api.name(device, new Date(Date.UTC(2026, 7, 1, 10, i)), i + 1)),
        JSON.stringify({ from: device }));
    }
  }
  await api.prune();
  const left = [...await api.list()];
  for (const device of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'feeeeeeeeeee']) {
    assert.ok(left.some(entry => entry.deviceId === device),
      `${device} still has a recovery point`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P3-01: the Google comments describe the one-way code that is actually there', () => {
  // The scope comment claimed the readonly scope was "gone" and described
  // pushes re-reading their target cells. None of that is true, and it read as
  // licence to add a write path. Comments are maintenance instructions.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('const GOOGLE_VAULT_KEY');
  const note = source.slice(start, source.indexOf('const GOOGLE_AUTH_ENDPOINT', start));
  assert.match(note, /READ ONLY/, 'the note says what the scope is');
  assert.doesNotMatch(note, /every push re-reads/, 'and does not describe a push path');
  assert.doesNotMatch(note, /readonly scope is\n\/\/ gone/, 'or claim the scope was removed');
  // The guarantee itself, unchanged.
  assert.match(source,
    /const GOOGLE_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/spreadsheets\.readonly'/);
});

test('Google credentials pasted with stray whitespace are accepted', () => {
  // Reported live: the client ID field visibly contained the operator's client
  // ID, Save was refused, and the app then said "No client ID saved yet" and
  // "Add the Google OAuth client ID in Settings before connecting". The value
  // had spaces inside it from the paste; .trim() only removes the ends.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("_secureHandle('google-set-credentials'");
  const handler = source.slice(start, source.indexOf('_secureHandle(', start + 10));
  assert.ok(handler.includes('_cleanGoogleClientId(request.clientId)'),
    'the client ID is cleaned, not merely trimmed');
  assert.ok(handler.includes('_cleanGoogleSecret(request.clientSecret)'),
    'and so is the secret — a paste can pick up a trailing newline');

  // The validator itself is unchanged and still strict.
  const validator = source.slice(source.indexOf('function _validGoogleClientId('));
  const pattern = /\^\[0-9\]\{6,32\}-\[A-Za-z0-9_\]\{8,64\}\\\.apps\\\.googleusercontent\\\.com\$/;
  assert.match(validator.slice(0, 300), pattern, 'the shape requirement still holds');

  // The exact value from the report, before and after.
  const shape = /^[0-9]{6,32}-[A-Za-z0-9_]{8,64}\.apps\.googleusercontent\.com$/;
  const pasted = '235779015004- 5m1 ddq0k4p1v4mq77lfl6513lcpbe3e. apps.googleusercontent.com';
  assert.equal(shape.test(pasted.trim()), false, 'trimming alone did not save it');
  assert.equal(shape.test(pasted.replace(/\s+/g, '')), true, 'stripping whitespace does');

  // Junk is still refused — normalizing must not become "accept anything".
  for (const junk of ['not a client id', '', 'abc.apps.googleusercontent.com',
                      '123-short.apps.googleusercontent.example.com']) {
    assert.equal(shape.test(junk.replace(/\s+/g, '')), false, `${junk} is still refused`);
  }
});

test('the renderer cleans the client ID field so it shows what will be saved', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = renderer.indexOf('async function saveGoogleCredentials(');
  const body = renderer.slice(start, renderer.indexOf('\n}\n', start));
  assert.match(body, /idField\.value !== clientId\) idField\.value = clientId/,
    'the field is corrected in place rather than silently differing from the vault');
});

test('an unreadable Google vault is reported as such, not as "nothing saved"', () => {
  // _googleVault() swallowed every error and returned {}. So a vault that could
  // not be decrypted produced the identical message to one that was simply
  // empty: "Add the Google OAuth client ID in Settings before connecting."
  // On a second Mac that is the difference between a five-second fix and an
  // hour of guessing.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const vault = source.slice(source.indexOf('function _googleVault('),
    source.indexOf('function _saveGoogleVault('));
  assert.match(vault, /_googleVaultReadError = String\(error\?\.message \|\| error\)/,
    'the read failure is recorded rather than discarded');
  assert.match(vault, /_googleVaultReadError = null;/, 'and cleared on a good read');

  const begin = source.slice(source.indexOf("_secureHandle('google-oauth-begin'"));
  assert.match(begin.slice(0, 900), /could not be read/,
    'connecting names the real problem');

  const status = source.slice(source.indexOf("_secureHandle('google-status'"));
  assert.match(status.slice(0, 600), /vaultError: _googleVaultReadError \|\| null/,
    'and Settings can show it');

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /could not be read: \$\{status\.vaultError\}/);
});

test('a Google client ID with invisible characters is accepted', () => {
  // Reported live, twice. The field showed a perfectly correct client ID and
  // Save kept refusing it. The visible text validates fine — what was stored
  // had characters that render as nothing wedged into it, and JavaScript's \s
  // does NOT match zero-width spaces, soft hyphens, bidi marks or the BOM. So
  // the first fix (strip whitespace) looked right and changed nothing at all.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(source.includes('const INVISIBLE ='), 'the invisible-character class exists');
  for (const codepoint of ['u200B', 'u200F', 'u2028', 'u2060', 'uFEFF', 'u00AD']) {
    assert.ok(source.includes(codepoint), `${codepoint} must be stripped — \\s does not cover it`);
  }

  // Behaviour, not shape. Characters are built by code point so nothing here
  // depends on how this file survives an editor.
  const ch = code => String.fromCharCode(code);
  const INVISIBLE = new RegExp(
    '[\\s' + ch(0x00AD) + ch(0x034F) + ch(0x061C) + ch(0x180E) +
    ch(0x200B) + '-' + ch(0x200F) + ch(0x2028) + ch(0x2029) +
    ch(0x202A) + '-' + ch(0x202E) + ch(0x2060) + '-' + ch(0x206F) + ch(0xFEFF) + ']', 'g');
  const clean = v => String(v || '').replace(INVISIBLE, '').replace(/[^A-Za-z0-9._-]/g, '');
  const shape = /^[0-9]{6,32}-[A-Za-z0-9_]{8,64}\.apps\.googleusercontent\.com$/;
  const good = '235779015004-5m1ddq0k4p1v4mq77lfl6513lcpbe3e.apps.googleusercontent.com';
  const withChar = code => '235779015004-' + ch(code) + '5m1ddq0k4p1v4mq77lfl6513lcpbe3e.apps.googleusercontent.com';

  assert.equal(shape.test(good), true, 'precondition: the visible value is valid');
  const contaminated = [
    ['zero-width space', withChar(0x200B)],
    ['soft hyphen', withChar(0x00AD)],
    ['bidi mark', withChar(0x200E)],
    ['line separator', withChar(0x2028)],
    ['word joiner', withChar(0x2060)],
    ['non-breaking space', withChar(0x00A0)],
    ['BOM at the front', ch(0xFEFF) + good],
    ['smart quotes around it', ch(0x201C) + good + ch(0x201D)],
    ['spaces and a newline', '2357 79015004-\n5m1ddq0k4p1v4mq77lfl6513lcpbe3e. apps.googleusercontent.com'],
  ];
  for (const [label, value] of contaminated) {
    assert.equal(shape.test(value), false, `precondition: ${label} breaks it`);
    assert.equal(shape.test(clean(value)), true, `${label} is cleaned and accepted`);
  }

  // Cleaning must not become "accept anything".
  for (const junk of ['not-an-id', '', 'abc.apps.googleusercontent.com',
                      '123-short.apps.googleusercontent.example.com']) {
    assert.equal(shape.test(clean(junk)), false, `${JSON.stringify(junk)} is still refused`);
  }
});

test('a refused client ID says what was wrong with it', () => {
  // The client ID is public, so naming the problem is safe. The secret is not,
  // and is never described.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const describe = source.slice(source.indexOf('function _describeGoogleClientIdProblem('));
  assert.match(describe.slice(0, 900), /hidden or invalid character/,
    'it says characters were removed');
  const secretClean = source.slice(source.indexOf('function _cleanGoogleSecret('));
  assert.match(secretClean.slice(0, 500), /INVISIBLE/);
  assert.doesNotMatch(secretClean.slice(0, 500), /\[\^A-Za-z0-9/,
    'a secret is never rewritten beyond removing invisible characters');
});

test('a client ID of the wrong length is saved with a warning, not silently', () => {
  // A truncated client ID still matches the shape check, and Google answers it
  // with 'Error 401: invalid_client — The OAuth client was not found', which
  // reads like a project or test-user problem rather than a character missing
  // from what was pasted. That cost an hour.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handler = source.slice(source.indexOf("_secureHandle('google-set-credentials'"));
  assert.match(handler.slice(0, 2600), /suffix\.length === 32 \? null :/,
    'the 32-character convention is checked');
  assert.match(handler.slice(0, 2600), /copied incompletely/);
  assert.match(handler.slice(0, 4000), /reconnectRequired: !sameClient, lengthWarning/,
    'and returned to the renderer');

  // A warning, not a refusal — 32 is Google's convention, not a guarantee.
  const suffixOf = id => /-([A-Za-z0-9_]+)\.apps\.googleusercontent\.com$/.exec(id)?.[1] || '';
  const short = '235779015004-5m1ddq0k4p1v4mq77lfl6513lcpbe3e.apps.googleusercontent.com';
  const full = '235779015004-5m1ddq0k4p1v4mq77lfl6513lcpbe3ex.apps.googleusercontent.com';
  assert.equal(suffixOf(short).length, 31, 'the reported value really is one short');
  assert.equal(suffixOf(full).length, 32);
  assert.match(source, /warning, not a refusal/, 'documented as a warning');

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /result\.lengthWarning/, 'and the operator is shown it');
});


test('MB1188-052: the published directory can never exceed what a Mac will accept', async () => {
  // _applyStaffDirectory throws over MAX_DIRECTORY_ENTRIES and nothing bounded
  // what _buildStaffDirectory emitted, so enough lifetime removals made every
  // other Mac refuse the whole directory — silently, sync badge still green.
  // Since MB1188-047 that refusal also blocks publishing, turning a stale list
  // into a permanent studio-wide lockout that blames the connection.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function _buildStaffDirectory()');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('\nfunction _validDirectoryEntry', start));
  assert.match(body, /if \(entries\.length > MAX_DIRECTORY_ENTRIES\) \{/);
  assert.match(body, /entry\._deleted !== true/, 'live profiles are never dropped — they ARE the directory');
  assert.match(body, /_deletedAt \|\| ''\)\.localeCompare/, 'and the oldest tombstone goes first');
  assert.match(body, /let entries = _allAppProfiles\(\)/, 'the list is reassignable');

  // Executed: the trim keeps every live profile and lands exactly on the cap.
  const trimLine = body.slice(body.indexOf('if (entries.length > MAX_DIRECTORY_ENTRIES) {'));
  const trim = new Function('entries', 'MAX_DIRECTORY_ENTRIES',
    trimLine.slice(0, trimLine.indexOf('\n\n')) + '\n  return entries;');
  const built = [];
  for (let i = 0; i < 40; i += 1) built.push({ id: `l${i}`, name: `Live ${i}` });
  for (let i = 0; i < 40; i += 1) {
    built.push({ id: `d${i}`, name: `Gone ${i}`, _deleted: true, _deletedAt: `2026-0${1 + (i % 9)}-01T00:00:00.000Z` });
  }
  const trimmed = trim(built, 66);
  assert.equal(trimmed.length, 66, 'exactly at the ceiling');
  assert.equal(trimmed.filter(e => e._deleted !== true).length, 40, 'every live profile survives');
  const kept = trimmed.filter(e => e._deleted === true).map(e => e._deletedAt);
  assert.deepEqual(kept, [...kept].sort().reverse(), 'the newest tombstones are the ones kept');
  // A directory that already fits is returned untouched.
  const small = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', _deleted: true, _deletedAt: 'x' }];
  assert.deepEqual(trim(small.slice(), 66), small);
});

test('MB1188-052: the directory ceiling is sized to the real worst case', () => {
  // '+ 16' sounds generous and is not: the document also carries a removal
  // TOMBSTONE for every profile ever deleted, bounded at 200, so about 62
  // lifetime removals made every other Mac refuse the whole thing. The trim
  // bounds it either way, but a trim is not free — dropping a removal record
  // means the id appears on one side only at the next CAS rebase, and
  // _mergeTombstonedRecordLists reads presence on one side as creation, so the
  // removed profile comes back. Sized properly, the trim never fires.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source,
    /const MAX_DIRECTORY_ENTRIES =\s*\n\s*Object\.keys\(APP_PROFILE_ROLES\)\.length \* 2 \+ MAX_CUSTOM_STAFF_PROFILES \+ 200;/);
  assert.doesNotMatch(source, /MAX_DIRECTORY_ENTRIES = MAX_CUSTOM_STAFF_PROFILES \+ 16;/);

  // The arithmetic, against the file's own constants.
  const builtIns = (source.match(/const APP_PROFILE_ROLES = Object\.freeze\(\{([\s\S]*?)\}\);/) || [])[1];
  const builtInCount = (builtIns.match(/^\s*'[^']+':/gm) || []).length;
  const maxCustom = Number((source.match(/const MAX_CUSTOM_STAFF_PROFILES = (\d+);/) || [])[1]);
  const ceiling = builtInCount * 2 + maxCustom + 200;
  // live + every tombstone either list can hold, and the tombstone lists are
  // capped at 200 (custom) and the built-in count.
  const worstCase = builtInCount + maxCustom + builtInCount + 200;
  assert.ok(ceiling >= worstCase,
    `the ceiling (${ceiling}) must cover the worst document this app can build (${worstCase})`);
  assert.match(source, /\]\.slice\(-200\);/, 'the custom removal list really is bounded at 200');
});

// ── MB1188-060..062: what the final pass found in the main process ─────────

test('MB1188-060: re-adding a removed built-in restores it instead of colliding', () => {
  const add = main.slice(
    main.indexOf("_secureHandle('app-session-add-staff-profile'"),
    main.indexOf("_secureHandle('app-session-remove-staff-profile'"));
  assert.ok(add.length > 200, 'the add handler was found');
  assert.match(add, /const suppressedBuiltIn = Object\.keys\(APP_PROFILE_ROLES\)\.find\(/);
  assert.match(add, /REMOVED_BUILTIN_PROFILES_VAULT_KEY\] = stillRemoved;/);
  // Restored at Front Desk: this channel has no session gate, so it may lower
  // privilege but must never grant it.
  assert.match(add, /roles\[suppressedBuiltIn\] = 'Front Desk';/);
  assert.match(add, /builtIn: true \}/, 'and it is reported as the built-in it is');
});

test('MB1188-060: a vault poisoned by an older build heals itself', () => {
  // The collision used to throw from _customStaffProfilesFromVault, which is
  // reached by list-profiles, start-staff, add, remove AND export-directory —
  // so no staff could sign in on that Mac, and the renderer swallowed it.
  const normalizeStart = main.indexOf('function _normalizeStaffProfileName');
  const normalizeEnd = main.indexOf('\nfunction ', normalizeStart + 1);
  const box = { console };
  vm.runInNewContext(
    `${main.slice(normalizeStart, normalizeEnd)}; this.normalize = _normalizeStaffProfileName;`,
    box
  );
  const profilesFromVault = loadFunction('_customStaffProfilesFromVault', {
    STAFF_PROFILES_VAULT_KEY: 'app_staff_profiles_v1',
    MAX_CUSTOM_STAFF_PROFILES: 50,
    APP_PROFILE_ROLES: Object.freeze({
      'Elizabeth Chaves': 'Owner',
      'Carrie Gass': 'Operations & Events',
      'Ana Chaves': 'Front Desk',
      'Emma Minnetto': 'Front Desk',
    }),
    _isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    _normalizeStaffProfileName: box.normalize,
  });
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(profilesFromVault({
    app_staff_profiles_v1: [
      { name: 'Ana Chaves', role: 'Front Desk', createdAt: 1 },
      { name: 'Dana Reed', role: 'Front Desk', createdAt: 2 },
    ],
  })), [{ name: 'Dana Reed', role: 'Front Desk', createdAt: 2 }]);
  // Spacing and case variants of a built-in name are caught too, because the
  // check runs after normalization.
  assert.deepEqual(plain(profilesFromVault({
    app_staff_profiles_v1: [{ name: '  ana   CHAVES ', role: 'Front Desk', createdAt: 1 }],
  })), []);
});

test('MB1188-061: an incoming directory cannot delete what it does not name', () => {
  const owner = directoryHarness();
  const peer = directoryHarness();
  // The peer holds a profile the owner has never heard of — exactly what a
  // login-screen add produces, since publishing is owner-only.
  peer.state.vault.app_staff_profiles_v1 = [
    { name: 'Dana Reed', role: 'Front Desk', createdAt: 2 },
  ];
  assert.ok([...peer.api.profiles()].includes('Dana Reed:Front Desk'), 'precondition');

  peer.api.apply(dirEntries(owner));

  assert.ok([...peer.api.profiles()].includes('Dana Reed:Front Desk'),
    'silence is not a deletion — this used to destroy Dana and report success');
});

test('MB1188-061: a genuine tombstone still deletes', () => {
  const owner = directoryHarness();
  delete owner.state.vault.app_staff_profiles_v1;
  owner.state.vault.app_removed_custom_v1 = [{ name: 'Dana Reed', at: '2026-08-05T00:00:00.000Z' }];
  const peer = directoryHarness();
  peer.state.vault.app_staff_profiles_v1 = [
    { name: 'Dana Reed', role: 'Front Desk', createdAt: 2 },
  ];

  peer.api.apply(dirEntries(owner));

  assert.ok(![...peer.api.profiles()].some(p => p.startsWith('Dana Reed:')),
    'removals travel as tombstones and must still land');
});

test('MB1188-061: the merge rule is tombstone-then-version, incoming on a tie', () => {
  const merge = sliceFunction(main, '_mergeDirectoryEntries');
  assert.match(merge, /if \(nextVersion > heldVersion\)/);
  assert.match(merge, /if \(heldDead !== nextDead\) \{ if \(nextDead\)/,
    'a deletion is not undone by a copy that has not heard about it');
  assert.doesNotMatch(merge, /entry\.updated \|\| ''\) > String\(held\.updated/,
    'tie-breaking on updated is wrong here: local is stamped at apply time');
  // Built before the vault is read, because _buildStaffDirectory saves the meta.
  const apply = sliceFunction(main, '_applyStaffDirectory');
  assert.ok(apply.indexOf('const localEntries = _buildStaffDirectory();')
    < apply.indexOf('const vault = _loadSecretVault();'));
});

test('MB1188-062: an owner-passcode write re-reads the vault first', () => {
  // Both paths held a snapshot across two PBKDF2 rounds and wrote it back,
  // silently reverting anything saved in that window — a refreshed Microsoft
  // token, for instance, which disconnects the mailbox with no error.
  assert.match(main, /function _persistOwnerAuthRecord\(record\) \{\s*\n\s*const fresh = _loadSecretVault\(\);/);
  const stage = main.slice(main.indexOf("_secureHandle('app-session-stage-owner-pin'"),
    main.indexOf("_secureHandle('app-session-commit-owner-pin'"));
  assert.match(stage, /_persistOwnerAuthRecord\(record\);/);
  assert.doesNotMatch(stage, /vault\[OWNER_AUTH_VAULT_KEY\] = record;/);
});

test('MB1188-062: role overrides do not inherit Object.prototype', () => {
  // A profile named `constructor` resolved to a function, which made the whole
  // profile list uncloneable over IPC and stopped the login screen rendering.
  assert.match(main, /return Object\.assign\(Object\.create\(null\), stored\);/);
});

test('MB1188-062: a failed send refunds its rate-limit slot', () => {
  assert.match(main, /const rcReservedAt = Date\.now\(\);/);
  assert.match(main, /rcSendTimestamps\.splice\(reserved, 1\);/);
  assert.match(main, /const msReservedAt = Date\.now\(\);/);
  assert.match(main, /msSendTimestamps\.splice\(reserved, 1\);/);
});

test('MB1188-062: the updater refuses to walk backwards, and main survives a stray rejection', () => {
  assert.match(main, /autoUpdater\.allowDowngrade = false;/);
  assert.match(main, /process\.on\('unhandledRejection'/);
  // Still deliberately NOT uncaughtException — see the test above.
  assert.doesNotMatch(main, /process\.on\(['"]uncaughtException/);
  assert.match(main, /mainWindow\.loadFile\(htmlPath\)\.catch\(/);
});

// ── MB1188-069: the optional Operations Manager passcode ─────────────────────
//
// Two failure modes matter and they pull against each other. A bypass makes the
// feature pointless; a LOCKOUT is worse than not having it, because the whole
// point of making it opt-in was that nobody could be shut out by its existence.
// Most of what follows is about the second one.

function staffAuthApi() {
  const sandbox = {
    Object, JSON, Number, Buffer, Array, String, Boolean, Set, Map, Date, RegExp,
  };
  vm.runInNewContext(`
    var OWNER_AUTH_ITERATIONS = 310000;
    var MAX_STAFF_AUTH_VERSION = 1000000000;
    ${extractFunction(main, '_isPlainObject')}
    ${extractFunction(main, '_validOwnerVerifier')}
    ${extractFunction(main, '_validStaffAuthRecord')}
    ${extractFunction(main, '_incomingStaffAuthRecordWins')}
    ${extractFunction(main, '_validStaffPin')}
    this.valid = _validStaffAuthRecord;
    this.wins = _incomingStaffAuthRecordWins;
    this.validPin = _validStaffPin;
  `, sandbox);
  return sandbox;
}

const b64 = bytes => Buffer.alloc(bytes, 7).toString('base64');
const staffSet = version => ({
  version,
  active: { iterations: 310000, salt: b64(16), verifier: b64(32) },
});
const staffCleared = version => ({ version, cleared: true });

test('MB1188-069: only a real 4-digit passcode is accepted', () => {
  const { validPin } = staffAuthApi();
  for (const good of ['0000', '1234', '9999']) assert.equal(validPin(good), true, good);
  for (const bad of ['123', '12345', '12a4', '', '  12', '1234\n', 1234, null, undefined, {}]) {
    assert.equal(validPin(bad), false, String(bad));
  }
});

test('MB1188-069: a record has to carry a real verifier or be a real tombstone', () => {
  const { valid } = staffAuthApi();
  assert.equal(valid(staffSet(1)), true);
  assert.equal(valid(staffCleared(4)), true);
  // A tombstone must not smuggle a verifier in beside `cleared`.
  assert.equal(valid({ version: 2, cleared: true, active: staffSet(1).active }), false);
  // Versions have to be usable as a monotonic counter.
  assert.equal(valid({ ...staffSet(1), version: 0 }), false);
  assert.equal(valid({ ...staffSet(1), version: 1.5 }), false);
  assert.equal(valid({ ...staffSet(1), version: '2' }), false);
  // A weakened verifier is not a verifier.
  assert.equal(valid({ version: 1, active: { iterations: 1, salt: b64(16), verifier: b64(32) } }), false);
  assert.equal(valid({ version: 1, active: { iterations: 310000, salt: b64(4), verifier: b64(32) } }), false);
  assert.equal(valid(null), false);
  assert.equal(valid([staffSet(1)]), false);
});

test('MB1188-069: an arriving record only replaces a held one when it is newer', () => {
  const { wins } = staffAuthApi();
  assert.equal(wins(staffSet(1), undefined), true, 'nothing held yet');
  assert.equal(wins(staffSet(3), staffSet(2)), true);
  assert.equal(wins(staffSet(2), staffSet(3)), false, 'a stale Mac cannot rewind');
  // The one that actually bites: a Mac that has been off for a week still holds
  // the passcode somebody removed on the other Mac. Its copy must not win.
  assert.equal(wins(staffSet(1), staffCleared(2)), false);
  assert.equal(wins(staffCleared(2), staffSet(1)), true);
});

test('MB1188-069: an equal-version tie breaks the same way on both Macs', () => {
  const { wins } = staffAuthApi();
  const a = staffSet(2);
  const b = { version: 2, active: { iterations: 310000, salt: b64(16), verifier: Buffer.alloc(32, 9).toString('base64') } };
  // Exactly one of the two directions wins, so both Macs land on one record.
  assert.notEqual(wins(a, b), wins(b, a), 'the tie-break is antisymmetric, so it converges');
  // And a removal beats a set at the same version, in either direction.
  assert.equal(wins(staffCleared(2), staffSet(2)), true);
  assert.equal(wins(staffSet(2), staffCleared(2)), false);
});

test('MB1188-069: the renderer merge and the main merge break ties identically', () => {
  // If these two rules ever diverge the Macs stop converging: the store agrees
  // on one record while the vault that start-staff actually checks holds
  // another. Cheap to assert, and it is the kind of thing that rots.
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /_mergeVersionedRecordMaps/);
  assert.match(renderer, /if \(aCleared !== bCleared\) \{ merged\[key\] = _cloneJson\(aCleared \? a : b\); continue; \}/);
  assert.match(main, /if \(incomingCleared !== heldCleared\) return incomingCleared;/);
  assert.match(renderer, /JSON\.stringify\(a\) >= JSON\.stringify\(b\)/);
  assert.match(main, /return JSON\.stringify\(incoming\) > JSON\.stringify\(held\);/);
});

test('MB1188-069: the passcode is opt-in, so an unprotected profile signs in as before', () => {
  assert.match(main, /_secureHandle\('app-session-start-staff'[\s\S]*?const record = _activeStaffAuthRecord\(vault, requested\);\s*\n\s*if \(record\) \{/);
  // No record -> no prompt, no throw, straight to _setAppSession.
  assert.match(main, /_secureHandle\('app-session-start-staff'[\s\S]*?return _setAppSession\(_normalizeStaffProfileName\(requested\), role\)/);
  assert.match(preload, /startStaff:\s*\(request\) => ipcRenderer\.invoke\('app-session-start-staff', request\)/);
});

test('MB1188-069: losing the role cannot leave somebody stuck at a passcode prompt', () => {
  // _activeStaffAuthRecord refuses to report a record for a profile that no
  // longer holds the role — otherwise a demoted Operations Manager would be
  // asked for a passcode they can no longer change or clear themselves.
  const active = extractFunction(main, '_activeStaffAuthRecord');
  assert.match(active, /if \(_roleForAppProfile\(name\) !== STAFF_AUTH_ROLE\) return null;/);
  assert.match(active, /if \(!record \|\| record\.cleared === true\) return null;/);
});

// The prose in this region explains WHICH roles stay passwordless, so it names
// them. Assertions about what the code DOES have to read the code.
function withoutComments(source) {
  return source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
}

test('MB1188-069: only Operations Manager is protected — everyone else stays passwordless', () => {
  assert.match(main, /const STAFF_AUTH_ROLE = 'Operations Manager';/);
  assert.match(main, /const STAFF_PASSCODE_ROLES = new Set\(\[STAFF_AUTH_ROLE\]\);/);
  // Carrie's role and Step Up must never be reachable through this feature.
  const region = withoutComments(
    main.slice(main.indexOf('MB1188-069'), main.indexOf("_secureHandle('app-session-list-profiles'")));
  assert.doesNotMatch(region, /'Operations & Events'/);
  assert.doesNotMatch(region, /'Front Desk'/);
  assert.doesNotMatch(region, /'Step Up'/);
});

test('MB1188-069: you set your own passcode and nobody else’s', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-set-staff-passcode'"));
  const handler = region.slice(0, region.indexOf('// Remove a passcode'));
  assert.match(handler, /_requireAppRole\(STAFF_PASSCODE_ROLES\)/);
  // The target is the SIGNED-IN name. It is never taken from the request, so a
  // request cannot name somebody else.
  assert.match(handler, /const name = _normalizeStaffProfileName\(appSession\.name\);/);
  assert.doesNotMatch(handler, /request\.name/);
  // Changing one requires the current one.
  assert.match(handler, /if \(existing && !await _ownerPinMatches\(request\.currentPin, existing\.active\)\)/);
  // The verifier is rebuilt, never copied from the request.
  assert.match(handler, /active: await _buildOwnerVerifier\(request\.newPin\)/);
  assert.doesNotMatch(handler, /request\.(?:active|record|verifier)/);
});

test('MB1188-069: the owner can remove a forgotten passcode but cannot choose one', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-clear-staff-passcode'"));
  const handler = region.slice(0, region.indexOf("_secureHandle('app-session-apply-staff-passcodes'"));
  assert.match(handler, /if \(!isOwner && !isSelf\)/);
  assert.match(handler, /if \(!isOwner && !await _ownerPinMatches\(/, 'clearing your own still needs your own');
  // A tombstone, never a deletion — absence would let the other Mac put it back.
  assert.match(handler, /const record = \{ version: Math\.min\(existing\.version \+ 1, MAX_STAFF_AUTH_VERSION\), cleared: true \};/);
  // No path here can set a verifier, so a reset never hands anyone a passcode
  // that somebody else knows.
  assert.doesNotMatch(handler, /_buildOwnerVerifier/);
});

test('MB1188-069: the sync delivery channel needs a signed-in session', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-apply-staff-passcodes'"));
  const handler = region.slice(0, region.indexOf("_secureHandle('app-session-list-profiles'"));
  // Ungated, this was reachable from the login screen, where no session exists:
  // post a high-version tombstone, and the passcode is gone before anybody has
  // proved who they are.
  assert.match(handler, /_requireAppRole\(COMMUNICATION_ROLES\);/);
  assert.match(handler, /if \(!_boundedString\(rawName, 120\) \|\| !_validStaffAuthRecord\(record\)\) continue;/);
  assert.match(handler, /if \(!_incomingStaffAuthRecordWins\(record, records\[key\]\)\) continue;/);
});

test('MB1188-069: wrong passcodes are rate-limited, and a right one clears the count', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-start-staff'"));
  const handler = region.slice(0, region.indexOf('// Which profiles are passcode-protected'));
  assert.match(handler, /const lockedUntil = staffAuthLockedUntil\.get\(key\) \|\| 0;/);
  assert.match(handler, /if \(Date\.now\(\) < lockedUntil\)/);
  assert.match(handler, /_recordStaffAuthFailure\(key\);/);
  assert.match(handler, /_clearStaffAuthFailures\(key\);/);
  assert.match(extractFunction(main, '_recordStaffAuthFailure'), /failures >= 5/);
});

test('MB1188-069: the passcode itself is never stored, synced or returned', () => {
  const region = main.slice(main.indexOf('MB1188-069'), main.indexOf("_secureHandle('app-session-list-profiles'"));
  // What crosses the boundary back to the renderer is the record, which holds
  // only the PBKDF2 verifier — the same shape the owner passcode uses.
  assert.doesNotMatch(region, /pin:\s*(?:request\.|newPin|pin)/);
  assert.doesNotMatch(region, /newPin:\s*/);
  assert.match(region, /return \{ ok: true, name, record \};/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /if \(record\) next\[key\] = record;/, 'the renderer syncs the record, not the passcode');
});

test('MB1188-069: the login screen learns who is protected before any session exists', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-staff-passcode-status'"));
  const handler = region.slice(0, region.indexOf("_secureHandle('app-session-set-staff-passcode'"));
  assert.doesNotMatch(handler, /_requireAppRole/, 'ungated on purpose: no session exists yet at the login screen');
  // It reveals only the names the login screen already draws. The record is
  // used as a boolean and never reaches the payload, so no verifier, salt or
  // iteration count can leave through here.
  assert.match(handler, /\.map\(profile => profile\.name\)/);
  assert.doesNotMatch(withoutComments(handler), /\.salt|\.verifier|\.iterations|record\.active/);
  // One decrypt per call, not one per profile.
  assert.match(handler, /const vault = _loadSecretVault\(\);/);
  assert.match(handler, /_activeStaffAuthRecord\(vault, profile\.name\)/);
});

// ── MB1188-069 pentest: one bad record must not lock a role out of a Mac ─────

function staffRecordsApi() {
  // The vm's OWN Object/Array, not the host's — passing the host globals in
  // makes _isPlainObject reject every same-realm literal, which reads as
  // "everything is refused" and hides real defects.
  const sandbox = vm.createContext({ Buffer, console: { warn() {}, error() {}, log() {} } });
  vm.runInContext(`
    var OWNER_AUTH_ITERATIONS = 310000;
    var MAX_STAFF_AUTH_VERSION = 1000000000;
    var STAFF_AUTH_VAULT_KEY = 'app_staff_auth_v1';
    var STAFF_AUTH_ROLE = 'Operations Manager';
    var ROLES = { 'dana ops': 'Operations Manager', 'ana chaves': 'Front Desk' };
    function _roleForAppProfile(name) {
      try { return ROLES[_normalizeStaffProfileName(name).toLocaleLowerCase('en-US')] || null; }
      catch (_) { return null; }
    }
    ${extractFunction(main, '_isPlainObject')}
    ${extractFunction(main, '_validOwnerVerifier')}
    // Stubbed, not extracted: the real one contains a regex holding an
    // apostrophe, and extractFunction is quote-aware but not regex-aware, so it
    // runs past the end of the function. The name-folding behaviour it stands in
    // for is covered by the round-trip assertions further down.
    function _normalizeStaffProfileName(value) {
      if (typeof value !== 'string') throw new Error('Enter a staff name.');
      return value.trim().replace(/\\s+/g, ' ');
    }
    ${extractFunction(main, '_boundedString')}
    ${extractFunction(main, '_validStaffAuthRecord')}
    ${extractFunction(main, '_staffAuthRecords')}
    ${extractFunction(main, '_staffAuthName')}
    ${extractFunction(main, '_activeStaffAuthRecord')}
    this.records = _staffAuthRecords;
    this.active = _activeStaffAuthRecord;
    this.valid = _validStaffAuthRecord;
  `, sandbox);
  // Inputs have to be built INSIDE the vm. _isPlainObject compares against
  // Object.prototype, so a value constructed out here is rejected by every
  // check — which would read as "the record was dropped" no matter what the
  // code does, and hide a real regression behind a passing-looking failure.
  sandbox.into = value => vm.runInContext(`(${JSON.stringify(value)})`, sandbox);
  return sandbox;
}

const realRecord = {
  version: 1,
  active: { iterations: 310000, salt: Buffer.alloc(16, 7).toString('base64'), verifier: Buffer.alloc(32, 7).toString('base64') },
};

test('MB1188-069: a malformed record is dropped, and the valid ones still enforce', () => {
  const { records, active, into } = staffRecordsApi();
  const vault = into({ app_staff_auth_v1: { 'dana ops': realRecord, 'someone else': { version: 1, active: { iterations: 5 } } } });
  // The bug this replaces: _staffAuthRecords threw, start-staff calls it, so a
  // bad record belonging to somebody ELSE stopped every Operations Manager
  // signing in on that Mac — with no way to clear it from inside the app.
  // Exactly what MB1188-060 fixed one screen down for the profile list.
  assert.doesNotThrow(() => records(vault));
  assert.deepEqual(Object.keys(records(vault)), ['dana ops']);
  // Dropping never weakens a passcode that IS set.
  assert.equal(JSON.stringify(active(vault, 'Dana Ops')), JSON.stringify(realRecord));
});

test('MB1188-069: no shape of stored list can throw on the sign-in path', () => {
  const { records, into } = staffRecordsApi();
  for (const stored of [
    { ['x'.repeat(121)]: realRecord },
    { '': realRecord },
    { a: { version: 0, active: realRecord.active } },
    { a: { version: 1, active: { iterations: 310000, salt: Buffer.alloc(16, 7).toString('base64'), verifier: 'AAA=' } } },
    { a: null },
    { a: { version: 2, cleared: true, active: realRecord.active } },
    [], 'nope', 42, true,
  ]) {
    assert.doesNotThrow(() => records(into({ app_staff_auth_v1: stored })), JSON.stringify(stored));
  }
  // Spread first: the real one is a null-prototype object on purpose.
  assert.deepEqual({ ...records(into({})) }, {}, 'an absent list is simply empty');
});

test('MB1188-069: a record cannot be pinned at the top of the integer range', () => {
  const { valid, into } = staffRecordsApi();
  // At MAX_SAFE_INTEGER the next `version + 1` stops being a safe integer, so
  // every future set and clear would be invalid — and with the drop above, the
  // passcode would silently vanish instead. Capping keeps `version + 1` real.
  assert.equal(valid(into({ ...realRecord, version: 1000000000 })), true, 'the ceiling itself is usable');
  assert.equal(valid(into({ ...realRecord, version: 1000000001 })), false);
  assert.equal(valid(into({ ...realRecord, version: Number.MAX_SAFE_INTEGER })), false);
  assert.match(main, /const MAX_STAFF_AUTH_VERSION = 1000000000;/);
});

test('MB1188-069: setting refuses rather than writing a record it cannot read back', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-set-staff-passcode'"));
  const handler = region.slice(0, region.indexOf('// Remove a passcode'));
  assert.match(handler, /if \(!_validStaffAuthRecord\(record\)\) \{/);
  assert.ok(handler.indexOf('_validStaffAuthRecord(record)') < handler.indexOf('_saveSecretVault(fresh)'),
    'validated BEFORE the vault is written, not after');
});

test('MB1188-069: removing a passcode is clamped, never refused', () => {
  const region = main.slice(main.indexOf("_secureHandle('app-session-clear-staff-passcode'"));
  const handler = region.slice(0, region.indexOf("_secureHandle('app-session-apply-staff-passcodes'"));
  // Removal is the escape hatch for the whole feature. If it could fail, a
  // record at the ceiling would be permanent — the lockout the cap exists to
  // prevent, reintroduced by the cap itself.
  assert.match(handler, /Math\.min\(existing\.version \+ 1, MAX_STAFF_AUTH_VERSION\)/);
  assert.doesNotMatch(handler, /if \(!_validStaffAuthRecord\(record\)\)/);
});

// ── Codex 1.3.12 audit: P0-4 authorization, P1-1 lockout durability ──────────

test('P0-4 / MB1188-073: the authorization matrix, read off the handlers', () => {
  // Isaiah's ruling on the handoff: adding and removing profiles is routine
  // onboarding and stays with the Operations Manager; changing a ROLE is
  // granting privilege and went back to the Owner.
  const gate = channel => {
    const start = main.indexOf(`_secureHandle('${channel}'`);
    assert.notEqual(start, -1, `${channel} exists`);
    const body = main.slice(start, start + 600);
    if (/_requireAppRole\(new Set\(\['Owner'\]\)\)/.test(body)) return 'Owner';
    if (/_requireAppRole\(OPERATIONS_MANAGER_ROLES\)/.test(body)) return 'Owner+OpsManager';
    if (/_requireAppRole\(COMMUNICATION_ROLES\)/.test(body)) return 'any signed-in';
    if (/_requireAppRole\(STAFF_PASSCODE_ROLES\)/.test(body)) return 'OpsManager';
    return 'ungated';
  };
  assert.equal(gate('app-session-set-profile-role'), 'Owner');
  assert.equal(gate('app-session-export-directory'), 'Owner');
  assert.equal(gate('app-session-remove-staff-profile'), 'Owner+OpsManager');
  assert.equal(gate('app-session-set-staff-passcode'), 'OpsManager');
  // Clearing is COMMUNICATION_ROLES at the gate and then self-or-Owner inside,
  // which is what lets a manager clear their own with their current passcode.
  assert.equal(gate('app-session-clear-staff-passcode'), 'any signed-in');
});

test('P0-4 / MB1188-073: an import cannot hand out privilege unless an Owner ran it', () => {
  const context = vm.createContext({ Object, Set, Array, String, Number, JSON });
  vm.runInContext(`
    var PROFILE_ROLE_RANK = { 'Front Desk': 1, 'Operations & Events': 1, 'Operations Manager': 2 };
    var ASSIGNABLE_PROFILE_ROLES = ['Operations Manager', 'Operations & Events', 'Front Desk'];
    var APP_PROFILE_ROLES = { 'Elizabeth Chaves': 'Owner', 'Ana Chaves': 'Front Desk' };
    var HELD = { 'ana chaves': 'Front Desk' };
    function _roleForAppProfile(n){ return HELD[String(n).toLowerCase()] || APP_PROFILE_ROLES[n] || null; }
    // The exact decision from _applyStaffDirectory, in isolation.
    this.resolve = (incomingRole, name, elevate) => {
      let role = ASSIGNABLE_PROFILE_ROLES.includes(incomingRole) ? incomingRole : 'Front Desk';
      if (!elevate && role !== 'Owner') {
        const held = _roleForAppProfile(name) || APP_PROFILE_ROLES[name] || 'Front Desk';
        if (PROFILE_ROLE_RANK[role] > (PROFILE_ROLE_RANK[held] ?? 0)) role = held;
      }
      return role;
    };
  `, context);
  const { resolve } = context;
  // The escalation the code's own comment describes: an imported directory
  // promotes somebody, who could then act on everybody but the Owner.
  assert.equal(resolve('Operations Manager', 'Ana Chaves', false), 'Front Desk',
    'a non-Owner import cannot raise Ana');
  assert.equal(resolve('Operations Manager', 'Ana Chaves', true), 'Operations Manager',
    'an Owner import still can');
  // Lateral and downward moves are not escalation and still apply, so ordinary
  // synchronization is unaffected.
  assert.equal(resolve('Operations & Events', 'Ana Chaves', false), 'Operations & Events');
  assert.equal(resolve('Front Desk', 'Ana Chaves', false), 'Front Desk');
  assert.equal(resolve('nonsense', 'Ana Chaves', false), 'Front Desk');
});

test('P1-1 / MB1188-075: the passcode lockout survives quitting the app', () => {
  // Five wrong attempts started a five-minute lock held in a process Map, so
  // quitting cleared it — which is exactly what somebody guessing would do.
  const sandbox = vm.createContext({ Buffer, console: { warn() {} } });
  vm.runInContext(`
    var MAX_STAFF_LOCKOUT_MS = 24 * 60 * 60 * 1000;
    var STAFF_AUTH_LOCKOUT_VAULT_KEY = 'app_staff_auth_lockout_v1';
    var VAULT = {};
    var staffAuthFailures = new Map(), staffAuthLockedUntil = new Map();
    function _loadSecretVault(){ return VAULT; }
    function _saveSecretVault(v){ VAULT = v; }
    ${extractFunction(main, '_isPlainObject')}
    ${extractFunction(main, '_boundedString')}
    ${extractFunction(main, '_loadStaffAuthLockouts')}
    ${extractFunction(main, '_saveStaffAuthLockouts')}
    ${extractFunction(main, '_recordStaffAuthFailure')}
    ${extractFunction(main, '_clearStaffAuthFailures')}
    this.api = {
      fail: k => _recordStaffAuthFailure(k),
      clear: k => _clearStaffAuthFailures(k),
      lockedUntil: k => staffAuthLockedUntil.get(k) || 0,
      vault: () => VAULT,
      // A relaunch: the Maps are gone, the vault is not.
      relaunch: () => { staffAuthFailures.clear(); staffAuthLockedUntil.clear(); _loadStaffAuthLockouts(); },
      poison: v => { VAULT[STAFF_AUTH_LOCKOUT_VAULT_KEY] = v; },
    };
  `, sandbox);
  const api = sandbox.api;

  for (let i = 0; i < 5; i++) api.fail('megan');
  const locked = api.lockedUntil('megan');
  assert.ok(locked > Date.now(), 'five wrong attempts lock the profile');
  assert.ok(api.vault().app_staff_auth_lockout_v1, 'and it is written to the vault');

  api.relaunch();
  assert.equal(api.lockedUntil('megan'), locked, 'the lock survives a full restart');

  api.clear('megan');
  assert.equal(api.lockedUntil('megan'), 0, 'a correct passcode releases it');
  api.relaunch();
  assert.equal(api.lockedUntil('megan'), 0, 'and it stays released');
});

test('P1-1 / MB1188-075: a corrupt lockout record cannot lock somebody out forever', () => {
  const sandbox = vm.createContext({ Buffer, console: { warn() {} } });
  vm.runInContext(`
    var MAX_STAFF_LOCKOUT_MS = 24 * 60 * 60 * 1000;
    var STAFF_AUTH_LOCKOUT_VAULT_KEY = 'app_staff_auth_lockout_v1';
    var VAULT = {};
    var staffAuthFailures = new Map(), staffAuthLockedUntil = new Map();
    function _loadSecretVault(){ return VAULT; }
    function _saveSecretVault(v){ VAULT = v; }
    ${extractFunction(main, '_isPlainObject')}
    ${extractFunction(main, '_boundedString')}
    ${extractFunction(main, '_loadStaffAuthLockouts')}
    this.load = stored => {
      staffAuthFailures.clear(); staffAuthLockedUntil.clear();
      VAULT = { app_staff_auth_lockout_v1: stored };
      _loadStaffAuthLockouts();
      return { until: staffAuthLockedUntil.get('megan') || 0, fails: staffAuthFailures.get('megan') || 0 };
    };
  `, sandbox);
  const load = sandbox.load;
  const year3000 = Date.parse('3000-01-01T00:00:00Z');
  assert.equal(load({ megan: { failures: 5, until: year3000 } }).until, 0,
    'a lock a thousand years out is corrupt, not honoured');
  assert.equal(load({ megan: { failures: 5, until: Date.now() - 1000 } }).until, 0,
    'an expired lock is simply gone');
  assert.equal(load({ megan: { failures: 'many', until: 'soon' } }).fails, 0);
  assert.equal(load({ megan: null }).until, 0);
  assert.equal(load('not an object').until, 0);
  assert.equal(load([]).until, 0);
});

// ── 1.3.14 audit: durability and the role-rank hole ─────────────────────────

test('P1-2 / MB1188-084: the vault write is durable, not merely atomic', () => {
  const write = extractFunction(main, '_atomicWriteFileSync');
  // rename alone gives atomicity. Durability needs the DATA synced before the
  // rename, and the DIRECTORY synced after it, or a power loss can land the
  // rename without the contents.
  const dataSync = write.indexOf('fs.fsyncSync(handle)');
  const rename = write.indexOf('fs.renameSync(tmpPath, targetPath)');
  const dirSync = write.indexOf('fs.fsyncSync(dir)');
  assert.ok(dataSync !== -1 && rename !== -1 && dirSync !== -1, 'all three steps exist');
  assert.ok(dataSync < rename, 'the file is synced before anything points at it');
  assert.ok(rename < dirSync, 'the directory is synced after the rename');
  // A failed data sync must fail the write; only the directory sync is tolerated.
  assert.match(write, /catch \(error\) \{[\s\S]*?directory sync unavailable/);
  assert.match(write, /try \{ fs\.unlinkSync\(tmpPath\); \} catch \(_\) \{\}/,
    'a failed write leaves no temp file behind');
  assert.match(write, /if \(handle !== null\) \{ try \{ fs\.closeSync\(handle\); \}/,
    'and no leaked descriptor');
});

test('P1-2 / MB1188-084: a real crash-order check on the durable write', () => {
  // Executed, not asserted from source: the sequence of syscalls is the whole
  // guarantee, so it is recorded and checked in order.
  const calls = [];
  const fakeFs = {
    openSync: (p, mode) => { calls.push(`open:${String(p).includes('.tmp-') ? 'tmp' : 'dir'}`); return 7; },
    writeFileSync: () => calls.push('write'),
    fsyncSync: () => calls.push('fsync'),
    closeSync: () => calls.push('close'),
    renameSync: () => calls.push('rename'),
    unlinkSync: () => calls.push('unlink'),
  };
  const sandbox = vm.createContext({
    fs: fakeFs,
    path: { dirname: () => '/dir' },
    crypto: { randomBytes: () => ({ toString: () => 'abc123' }) },
    process: { pid: 1 },
    console: { warn() {} },
  });
  vm.runInContext(`${extractFunction(main, '_atomicWriteFileSync')}; this.write = _atomicWriteFileSync;`, sandbox);
  sandbox.write('/dir/vault.bin', 'data');
  assert.deepEqual(calls,
    ['open:tmp', 'write', 'fsync', 'close', 'rename', 'open:dir', 'fsync', 'close'],
    'data synced, then renamed, then the directory synced');
});

test('P0-1/P0-4: main journal persists the full capsule and retires only the acknowledged operation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-journal-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandbox = vm.createContext({
    fs, path, crypto, process, Buffer, JSON, Object, Number, String, Error,
    console: { warn() {} },
    __journalRoot: root,
  });
  vm.runInContext(`
    const JOURNAL_DIR = () => __journalRoot;
    const JOURNAL_KEY_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
    const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
    const MAX_JOURNAL_CAPSULE_BYTES = 6 * 1024 * 1024;
    const MAX_JOURNAL_ENTRIES = 200;
    let _journalSeq = 0;
    ${extractFunction(main, '_isPlainObject')}
    ${extractFunction(main, '_atomicWriteFileSync')}
    ${extractFunction(main, '_journalPath')}
    ${extractFunction(main, '_readJournalFile')}
    ${extractFunction(main, '_journalHighestSeq')}
    globalThis.put = async request => { ${extractHandlerBody(main, 'durable-journal-put')} };
    globalThis.ack = async request => { ${extractHandlerBody(main, 'durable-journal-ack')} };
    globalThis.read = async () => { ${extractHandlerBody(main, 'durable-journal-read')} };
  `, sandbox);

  const pending = JSON.stringify({
    version: 1,
    opId: 'durable_operation_0001',
    baseRevision: 7,
    baseCiphertext: 'E:before',
    localCiphertext: 'E:after',
    supersededOpIds: [],
    createdAt: '2026-08-13T00:00:00.000Z',
  });
  await sandbox.put({
    key: 'logs', ciphertext: 'E:after', schemaVersion: 2,
    previousCiphertext: 'E:before', pendingSync: pending,
    revision: '7', localTimestamp: '2026-08-13T00:00:00.000Z',
  });
  let record = (await sandbox.read()).records[0];
  assert.equal(record.ciphertext, 'E:after');
  assert.equal(record.previousCiphertext, 'E:before');
  assert.equal(record.pendingSync, pending);
  assert.equal(record.revision, '7');

  await sandbox.ack({ key: 'logs', opId: 'different_operation_9999' });
  record = (await sandbox.read()).records[0];
  assert.equal(record.pendingSync, pending, 'an unrelated acknowledgement changes nothing');

  await sandbox.ack({ key: 'logs', opId: 'durable_operation_0001' });
  record = (await sandbox.read()).records[0];
  assert.equal(record.pendingSync, null, 'the exact delivered operation is retired durably');

  await assert.rejects(
    sandbox.put({ key: 'logs', ciphertext: 'plaintext', schemaVersion: 2 }),
    /encrypted text only/,
  );
  await assert.rejects(
    sandbox.put({ key: 'logs', ciphertext: 'E:x', schemaVersion: 2, pendingSync: {} }),
    /pending operation is invalid/,
  );
  await assert.rejects(
    sandbox.put({ key: 'logs', ciphertext: 'E:x', schemaVersion: 2,
      revision: '99999999999999999999' }),
    /revision is invalid/,
  );
  await assert.rejects(
    sandbox.put({ key: 'logs', ciphertext: 'E:x', schemaVersion: 2,
      localTimestamp: 'not-a-time' }),
    /timestamp is invalid/,
  );

  fs.writeFileSync(path.join(root, 'forged.jrn'), JSON.stringify({
    key: 'logs', seq: 999999, ciphertext: 'E:forged-under-the-wrong-name',
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(
    (await sandbox.read()).records.map(item => item.key))), ['logs'],
    'a file whose name does not match its embedded key is ignored');
});

test('P0-3 / MB1188-081: Operations & Events outranks Front Desk', () => {
  // Equal rank meant a "non-elevating" import could move somebody from Front
  // Desk to Operations & Events — a grant of access they did not have.
  const sandbox = vm.createContext({ Object });
  vm.runInContext(`${main.slice(main.indexOf('const PROFILE_ROLE_RANK'),
    main.indexOf('function _profileRoleOverrides'))}; this.rank = PROFILE_ROLE_RANK;`, sandbox);
  const rank = sandbox.rank;
  assert.ok(rank['Operations & Events'] > rank['Front Desk'],
    'moving up to Operations & Events is an elevation');
  assert.ok(rank['Operations Manager'] > rank['Operations & Events']);
  assert.equal(rank.Owner, undefined, 'Owner is never assignable, so it has no rank');
});

test('P0-3 / MB1188-081: main reports what it refused to apply', () => {
  const apply = main.slice(main.indexOf('function _applyStaffDirectory'),
                           main.indexOf("_secureHandle('app-session-export-directory'"));
  assert.match(apply, /function _applyStaffDirectory\(entries, \{ elevate = false, deferred = \[\] \} = \{\}\)/);
  assert.match(apply, /deferred\.push\(\{ name, requested: role, held \}\);/);
  const handler = extractHandlerBody(main, 'app-session-import-directory');
  assert.match(handler, /const deferred = \[\];/);
  assert.match(handler, /return \{ ok: true, profiles, deferred, applied: deferred\.length === 0 \};/,
    'the caller can tell a complete apply from a partial one');
});

test("P0-2: Operations Manager removal is Isaiah's decision, not an oversight", () => {
  // Two audits have now called this a defect. It is not: asked directly on
  // 2026-08-13, Isaiah chose a narrow split: Operations Manager may remove
  // Front Desk or Operations & Events profiles, but cannot add users, change
  // roles, reset passcodes, remove another manager, or remove an Owner.
  // Recorded here so the next audit argues with the decision, not the code.
  const removeBody = main.slice(main.indexOf("_secureHandle('app-session-remove-staff-profile'"));
  assert.match(removeBody.slice(0, 200), /_requireAppRole\(OPERATIONS_MANAGER_ROLES\)/,
    'removal is deliberately available to an Operations Manager');
  const roleBody = main.slice(main.indexOf("_secureHandle('app-session-set-profile-role'"));
  assert.match(roleBody.slice(0, 300), /_requireAppRole\(new Set\(\['Owner'\]\)\)/,
    'granting a role is Owner-only');
  // The half that actually closed the escalation chain.
  assert.match(main, /elevate: _appSessionHasRole\(new Set\(\['Owner'\]\)\)/);
});

// ── P0-3 / MB1188-081: a two-Mac directory exchange, executed ────────────────
//
// Not a source-pattern test. Mac A publishes through the real
// _buildStaffDirectory; Mac B applies it through the real handler body under
// each possible signed-in role, and the resulting vault is read back.

test('P0-3: an owner-published elevation is never silently dropped', () => {
  const A = directoryHarness({ role: 'Owner', vault: { app_profile_roles_v1: { 'Ana Chaves': 'Operations Manager' } } });
  const published = JSON.parse(JSON.stringify(A.api.build()));
  assert.equal(A.api.roleOf('Ana Chaves'), 'Operations Manager', 'Mac A promoted Ana');

  const outcomes = {};
  for (const role of ['Front Desk', 'Operations & Events', 'Operations Manager', 'Owner']) {
    const B = directoryHarness({ role, signedInAs: 'Somebody', vault: {} });
    assert.equal(B.api.roleOf('Ana Chaves'), 'Front Desk', 'Mac B starts behind');
    const result = B.api.importDirectory(published);
    outcomes[role] = { role: B.api.roleOf('Ana Chaves'), applied: result.applied, deferred: result.deferred.length };
  }

  // Only an Owner session may apply the elevation...
  assert.deepEqual(outcomes.Owner, { role: 'Operations Manager', applied: true, deferred: 0 });
  // ...and every other session must say so rather than claiming success. This
  // is the defect: the role was dropped AND applied was true, so the sync layer
  // marked the revision consumed and never delivered it again.
  for (const role of ['Front Desk', 'Operations & Events', 'Operations Manager']) {
    assert.deepEqual(outcomes[role], { role: 'Front Desk', applied: false, deferred: 1 },
      `${role} defers rather than silently discarding`);
  }
});

test('P0-3: a lateral move to Operations & Events is an elevation too', () => {
  // Equal rank made this a "non-elevating" change, so a Front Desk session
  // could grant Operations & Events access without an Owner anywhere.
  const A = directoryHarness({ role: 'Owner', vault: { app_profile_roles_v1: { 'Ana Chaves': 'Operations & Events' } } });
  const published = JSON.parse(JSON.stringify(A.api.build()));

  const front = directoryHarness({ role: 'Front Desk', signedInAs: 'Somebody', vault: {} });
  const held = front.api.importDirectory(published);
  assert.equal(front.api.roleOf('Ana Chaves'), 'Front Desk', 'not granted');
  assert.equal(held.applied, false, 'and reported as not applied');

  const owner = directoryHarness({ role: 'Owner', vault: {} });
  const applied = owner.api.importDirectory(published);
  assert.equal(owner.api.roleOf('Ana Chaves'), 'Operations & Events');
  assert.equal(applied.applied, true);
});

test('P0-3: a demotion applies under any session, because it grants nothing', () => {
  // The gate is about ELEVATION. Revoking access must not wait for an Owner —
  // that would leave somebody holding authority the studio has taken away.
  const A = directoryHarness({ role: 'Owner', vault: { app_profile_roles_v1: { 'Carrie Gass': 'Front Desk' } } });
  const published = JSON.parse(JSON.stringify(A.api.build()));
  const B = directoryHarness({ role: 'Front Desk', signedInAs: 'Somebody', vault: {} });
  assert.equal(B.api.roleOf('Carrie Gass'), 'Operations & Events', 'starts with the shipped role');
  const result = B.api.importDirectory(published);
  assert.equal(B.api.roleOf('Carrie Gass'), 'Front Desk', 'the demotion lands immediately');
  assert.equal(result.applied, true, 'and is a complete apply');
});

test('P0-3: retrying the same directory after an Owner signs in settles it', () => {
  // The pending marker exists so the held-back change is re-applied later. This
  // proves the second attempt actually converges rather than deferring forever.
  const A = directoryHarness({ role: 'Owner', vault: { app_profile_roles_v1: { 'Ana Chaves': 'Operations Manager' } } });
  const published = JSON.parse(JSON.stringify(A.api.build()));

  const B = directoryHarness({ role: 'Front Desk', signedInAs: 'Somebody', vault: {} });
  assert.equal(B.api.importDirectory(published).applied, false);
  assert.equal(B.api.roleOf('Ana Chaves'), 'Front Desk');

  // Same Mac, same stored directory, Owner now signed in.
  const owner = directoryHarness({ role: 'Owner', vault: B.state.vault });
  const retry = owner.api.importDirectory(published);
  assert.equal(retry.applied, true, 'the retry completes');
  assert.equal(owner.api.roleOf('Ana Chaves'), 'Operations Manager');
  // Idempotent: applying again changes nothing and still reports complete.
  const again = owner.api.importDirectory(published);
  assert.equal(again.applied, true);
  assert.equal(owner.api.roleOf('Ana Chaves'), 'Operations Manager');
});
