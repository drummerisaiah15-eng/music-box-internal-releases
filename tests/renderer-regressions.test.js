const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererPath = path.join(__dirname, '..', 'index.html');
const mainPath = path.join(__dirname, '..', 'main.js');
const preloadPath = path.join(__dirname, '..', 'preload.js');
const source = fs.readFileSync(rendererPath, 'utf8');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');

function inlineScript(html) {
  const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const appScript = matches.find(match => match[0].startsWith('<script>'));
  assert.ok(appScript, 'the application inline script exists');
  return appScript[1];
}

const script = inlineScript(source);

function namedFunctionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = script.indexOf('\nfunction ', start + 10);
  return script.slice(start, next === -1 ? script.length : next);
}

test('the complete renderer script parses', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html:inline.js' }));
});

test('startup tolerates features whose removed controls are no longer in the DOM', () => {
  const init = namedFunctionSource('init');
  assert.match(init, /const initialScheduleDate = document\.getElementById\('schedule-date-picker'\)/);
  assert.match(init, /if \(initialScheduleDate\) initialScheduleDate\.value = _initToday/);
  assert.doesNotMatch(init, /document\.getElementById\('schedule-date-picker'\)\.value/);
});

test('encrypted maintenance and cloud sync begin only after successful login', () => {
  const init = namedFunctionSource('init');
  const login = namedFunctionSource('completeLogin');
  const startup = init.slice(init.indexOf('// ── Normal startup'));
  assert.doesNotMatch(startup, /pruneOldLogs|migrateRoomData|startAutoRefresh|refreshDashboard/);
  assert.match(login, /_postLoginMaintenancePromise = runPostLoginMaintenance\(\)/);
  assert.match(login, /_postLoginMaintenancePromise\.then\(\(\) => \{[\s\S]*initFirebase\(\)/);
});

test('Mass Email removal leaves no executable or hidden contact UI', () => {
  for (const orphan of [
    '_mirrorContactsToShared',
    'add-contact-modal',
    'edit-contact-modal',
    'saveAddContact',
    'saveEditContact',
    'deleteEditContact',
  ]) {
    assert.equal(source.includes(orphan), false, `removed orphan still present: ${orphan}`);
  }
  assert.match(
    source,
    /STORE\.get\('deleted_emails'/,
    'Microsoft email deletion state remains operational and is not Mass Email data'
  );
});

test('STORE serializes local writes through an encryption queue and never writes plaintext first', () => {
  assert.match(script, /const _storeWriteChains = new Map\(\)/);
  assert.match(script, /function _queueEncryptedWrite\(/);
  assert.doesNotMatch(script, /Write synchronously \(unencrypted\) first/);
  assert.doesNotMatch(script, /localStorage\.setItem\('tmb_' \+ k, JSON\.stringify\(v\)\)/);
});

test('Save All awaits acknowledged writes and never uploads local ciphertext', () => {
  assert.match(script, /await Promise\.allSettled\(/);
  assert.doesNotMatch(script, /syncPush\(key,\s*raw\)/);
  assert.match(
    script,
    /getSyncKeys\(\)\.filter\(key => Object\.prototype\.hasOwnProperty\.call\(_decCache, key\)\)/
  );
  assert.match(script, /STORE\.flush\(keys, \{ includeSync: true, requireSync: true \}\)/);
});

test('Firebase remote values are validated, encrypted locally, and refresh their feature', () => {
  assert.match(script, /function _normalizeSyncValue\(/);
  assert.match(script, /await _persistRemoteValue\(/);
  assert.match(script, /function _refreshForSyncKey\(/);
  assert.doesNotMatch(script, /_decCache\[key\]\s*=\s*remote\.value\s*;/);
});

test('iCloud uses a versioned portable envelope and reports automatic behavior accurately', () => {
  assert.match(script, /TMB_CLOUD_ENVELOPE_VERSION/);
  assert.match(script, /keySalt/);
  assert.match(script, /async function _decodeCloudEnvelope/);
  assert.match(source, /Manual encrypted backup/);
  assert.doesNotMatch(source, /automatically syncs your data/i);
});

test('HTML and attribute escaping cover quotes and line breaks without emitting markup', () => {
  assert.match(script, /function escHtml\(s\)[\s\S]*?&quot;/);
  assert.match(script, /function escAttr\(s\)/);
  assert.doesNotMatch(script, /replace\(\/\\n\/g,'<br>'\)/);
});

test('Graph email HTML is converted through an inert document without executing markup', () => {
  const helperSource = namedFunctionSource('_extractInertTextFromNode');
  const stripSource = namedFunctionSource('stripHtml');
  assert.match(stripSource, /new DOMParser\(\)\.parseFromString\(source, 'text\/html'\)/);
  assert.doesNotMatch(stripSource, /\.innerHTML|insertAdjacentHTML|document\.createElement/);

  let parsedSource = '';
  let handlerRead = false;
  const textNode = value => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
  const element = (name, childNodes = [], extras = {}) => ({
    nodeType: 1,
    nodeName: name,
    childNodes,
    ...extras,
  });
  const maliciousImage = element('IMG');
  Object.defineProperty(maliciousImage, 'onerror', {
    get() {
      handlerRead = true;
      throw new Error('inline handler was touched');
    },
  });
  const inertBody = element('BODY', [
    textNode('Hello'),
    maliciousImage,
    element('SCRIPT', [textNode('globalThis.pwned = true')]),
    element('DIV', [textNode('Second'), element('BR'), textNode('line')]),
    element('SVG', [textNode('ignored active content')]),
  ]);
  class FakeDOMParser {
    parseFromString(value, type) {
      parsedSource = value;
      assert.equal(type, 'text/html');
      return { body: inertBody };
    }
  }
  const malicious = 'Hello<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script><div>Second<br>line</div>';
  const context = { DOMParser: FakeDOMParser, __input: malicious, pwned: false };
  const result = vm.runInNewContext(
    `${helperSource}\n${stripSource}\nstripHtml(__input)`,
    context
  );
  assert.equal(parsedSource, malicious);
  assert.equal(result, 'Hello\nSecond\nline');
  assert.equal(handlerRead, false);
  assert.equal(context.pwned, false);
});

test('Microsoft OAuth and Graph authority stay behind the main-process proxy', () => {
  assert.match(script, /ms_oauth_state_/);
  assert.match(script, /state\s*!==\s*expectedState/);
  assert.match(mainSource, /new URLSearchParams\(\{[\s\S]*?\bstate,/);
  assert.doesNotMatch(script, /tmb_shared_ms_token_/);
  assert.match(script, /window\.electronMicrosoft\.status\(/);
  assert.match(script, /window\.electronMicrosoft\.fetchMail\(/);
  assert.match(script, /window\.electronMicrosoft\.sendMail\(/);
  assert.match(
    script,
    /window\.electronAuth\.begin\(\{\s*accountId,\s*tenant: acct\.tenant,\s*clientId: acct\.clientId/
  );
  assert.match(
    script,
    /window\.electronAuth\.exchangeCode\(\{\s*accountId: acctId,\s*state,\s*codeVerifier: verifier/
  );
  assert.doesNotMatch(source, /https:\/\/graph\.microsoft\.com/);
  assert.doesNotMatch(script, /\bgetMsToken\b|\bgetMsRefreshToken\b|Authorization:\s*['"]Bearer/);
  assert.doesNotMatch(script, /\baccess_token\b|\brefresh_token\b/);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\('electronSecrets'/);
  assert.doesNotMatch(preloadSource, /secret-get|secret-set|secret-remove|refresh-ms-token/);
  assert.doesNotMatch(
    script,
    /console\.(?:log|warn)\([^)]*(?:access_token|refresh_token|Code received|Exchange result)/i
  );
});

test('Firebase password retrieval is owner-only and cleared after authentication', () => {
  assert.match(
    mainSource,
    /_secureHandle\('firebase-runtime-config'[\s\S]*?_requireAppRole\(new Set\(\['Owner'\]\)\)/
  );
  assert.match(mainSource, /if \(firebaseRuntimeSecretIssued\)[\s\S]*already delivered for this owner session/);
  assert.match(mainSource, /if \(_validFirebaseConfig\(config\)\) firebaseRuntimeSecretIssued = true/);
  assert.match(script, /_loadFirebaseSecrets\(\{ includePassword: true \}\)/);
  assert.match(
    script,
    /signInWithEmailAndPassword\(email, password\)[\s\S]*?delete _firebaseSecretCache\[FIREBASE_SECRET_KEYS\.password\]/
  );
  assert.match(
    script,
    /!isElizabeth\(\) && _syncReady && _firestoreDb && _firebaseAuth\?\.currentUser/
  );
  assert.doesNotMatch(preloadSource, /electronSecrets|secret-get|secret-set|secret-remove/);
});

test('owner passcode changes stage and resolve the main verifier transaction', () => {
  const changePin = namedFunctionSource('changePin');
  assert.match(changePin, /window\.electronSession\.stageOwnerPin\(\{/);
  assert.match(changePin, /currentPin: _activePin,\s*newPin: val/);
  assert.match(changePin, /window\.electronSession\.commitOwnerPin\(ownerAuthRotationId\)/);
  assert.match(changePin, /window\.electronSession\?\.cancelOwnerPin/);
  assert.ok(
    changePin.indexOf('stageOwnerPin') < changePin.indexOf('_commitPinHashState(nextPinState)'),
    'main verifier is staged before the local PIN commit'
  );
});

test('RingCentral credentials and requests stay behind the main-process proxy', () => {
  assert.match(script, /window\.electronRingCentral\.status\(\)/);
  assert.match(script, /window\.electronRingCentral\.configure\(/);
  assert.match(script, /window\.electronRingCentral\.fetchData\(\)/);
  assert.match(script, /window\.electronRingCentral\.sendSms\(/);
  assert.doesNotMatch(source, /platform\.ringcentral\.com/);
  assert.doesNotMatch(script, /_getRcAccessToken/);
  assert.doesNotMatch(script, /fetch\([^)]*ringcentral/i);
});

test('native text editing is not replaced by a global UTF-16 deletion shim', () => {
  assert.doesNotMatch(script, /applies deletions manually/);
  assert.doesNotMatch(script, /el\.value\.slice\(0,\s*s\s*-\s*1\)/);
});

test('legacy demo cleanup runs only after unlock and marks completion after save', () => {
  assert.match(
    script,
    /async function _purgeLegacyDemoDataOnce\(\)[\s\S]*?!_encKey[\s\S]*?await STORE\.flush\(\['logs', 'staff_notes'\]\)[\s\S]*?localStorage\.setItem\('tmb_demo_purged_v1', '1'\)/
  );
  assert.doesNotMatch(
    script,
    /function init\(\)[\s\S]*?STORE\.set\('logs',\s*cleanedLogs\)/
  );
});

test('receipt images are format-limited, resized, and compressed before AI submission', () => {
  assert.match(source, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.doesNotMatch(source, /accept="image\/\*"/);
  assert.match(script, /MAX_RECEIPT_IMAGE_DIMENSION = 2000/);
  assert.match(script, /MAX_RECEIPT_COMPRESSED_BYTES = 1800 \* 1024/);
  assert.match(script, /createImageBitmap\(file\)/);
  assert.match(script, /canvas\.toBlob\(resolve, 'image\/jpeg'/);
  assert.doesNotMatch(script, /data:image\\\/\(\?:[\s\S]*?heic/);
});

test('AI spend control is labeled as a per-device estimate with current model rates', () => {
  assert.match(script, /AI_DEVICE_MONTHLY_PAUSE_USD = 15\.00/);
  assert.match(script, /'claude-opus-4-5':\s*\{ input:\s*5\.00, output:\s*25\.00 \}/);
  assert.match(script, /'claude-haiku-4-5-20251001':\s*\{ input:\s*1\.00, output:\s*5\.00 \}/);
  assert.match(source, /This Mac's estimated AI-use pause/);
  assert.match(source, /Anthropic billing may differ/);
  assert.doesNotMatch(source, /AI monthly budget/);
});

test('auto-refresh registration is idempotent and resume work is single-flight', () => {
  const start = namedFunctionSource('startAutoRefresh');
  const resume = namedFunctionSource('_resumeAutoRefresh');
  const work = namedFunctionSource('_runAutoRefreshWork');
  assert.match(script, /let _autoRefreshVisibilityHandler = null/);
  assert.match(script, /let _autoRefreshFocusHandler = null/);
  assert.match(script, /let _autoRefreshWorkPromise = null/);
  assert.match(
    start,
    /removeEventListener\('visibilitychange', _autoRefreshVisibilityHandler\)[\s\S]*addEventListener\('visibilitychange', _autoRefreshVisibilityHandler\)/
  );
  assert.match(
    start,
    /removeEventListener\('focus', _autoRefreshFocusHandler\)[\s\S]*addEventListener\('focus', _autoRefreshFocusHandler\)/
  );
  assert.match(work, /if \(_autoRefreshWorkPromise\) return _autoRefreshWorkPromise/);
  assert.match(resume, /awayMs <= 15 \* 60 \* 1000/);
  assert.doesNotMatch(start, /addEventListener\('(?:visibilitychange|focus)', async \(\)/);
});

test('native and dynamic text fields receive bounded lengths without splitting emoji', () => {
  const boundedSource = namedFunctionSource('boundedText');
  const maxSource = namedFunctionSource('inputMaxLengthFor');
  const applySource = namedFunctionSource('applyInputSizeLimit');
  const installSource = namedFunctionSource('installInputSizeLimits');
  const boundedContext = { value: `a${'😀'.repeat(3)}` };
  const bounded = vm.runInNewContext(
    `${boundedSource}\nboundedText(value, 4)`,
    boundedContext
  );
  assert.equal(bounded, 'a😀');
  assert.equal(bounded.endsWith('\uD83D'), false, 'a high surrogate is never left dangling');

  const attributes = new Map();
  const element = {
    tagName: 'INPUT',
    id: 'plain-dynamic-field',
    type: 'text',
    getAttribute: name => attributes.get(name) || null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  vm.runInNewContext(
    `const UI_INPUT_MAX_LENGTHS = {};\n${maxSource}\n${applySource}\napplyInputSizeLimit(element)`,
    { element, Number }
  );
  assert.equal(attributes.get('maxlength'), '4096');
  assert.match(installSource, /querySelectorAll\('input, textarea'\)/);
  assert.match(installSource, /addEventListener\('focusin'/);
  assert.match(installSource, /addEventListener\('input'/);
  assert.match(script, /'policy-import-text': 500000/);
  assert.match(script, /'rc-reply-box': 2000/);
  assert.match(script, /'rc-jwt': 16384/);
});

test('spreadsheet typing, paste, and imports have explicit resource bounds', () => {
  assert.match(script, /MAX_SPREADSHEET_CELL_CHARS = 50000/);
  assert.match(script, /MAX_SPREADSHEET_GRID_CELLS = 10000/);
  assert.match(script, /MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000/);
  assert.match(mainSource, /MAX_SPREADSHEET_SOURCE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(mainSource, /utilityProcess\.fork\(workerPath/);
  assert.match(mainSource, /spreadsheet-worker\.js/);
  assert.match(preloadSource, /importFile:\s+\(\) => ipcRenderer\.invoke\('import-spreadsheet'\)/);
  assert.doesNotMatch(namedFunctionSource('ssImportFile'), /FileReader|XLSX\.read/);
  assert.match(namedFunctionSource('ssImportBuildProject'), /normalizeSpreadsheetWorkbook\(next\)/);
  // V160-005: import is an explicit whole-workbook replacement, so it uses the
  // reviewed STORE.replace() path rather than STORE.set(). It must NOT silently
  // fall back to the collision-unsafe STORE.set() call.
  assert.match(namedFunctionSource('ssImportBuildProject'), /await STORE\.replace\('spreadsheets', normalized\)/);
  assert.doesNotMatch(namedFunctionSource('ssImportBuildProject'), /STORE\.set\(/);
  assert.match(namedFunctionSource('ssCellInput'), /_scheduleSpreadsheetSave\(\)/);
  assert.match(namedFunctionSource('ssCellInput'), /rawValue\.length > MAX_SPREADSHEET_CELL_CHARS/);
  assert.match(source, /onpaste="[^"]*MAX_SPREADSHEET_CELL_CHARS/);
});

test('large archive searches are debounced before rebuilding their DOM', () => {
  assert.match(namedFunctionSource('queueUiRender'), /clearTimeout\(prior\)/);
  assert.match(source, /queueUiRender\('rc-search'/);
  assert.match(source, /queueUiRender\('log-search',renderLogs\)/);
  assert.match(source, /queueUiRender\('receipt-search',renderStepUpArchive\)/);
});

test('login can add only main-authorized Front Desk profiles', () => {
  assert.match(source, /id="add-login-user-btn"[^>]*>\+ Add New User</);
  assert.match(source, /New users receive Front Desk access, like Ana and Emma/);
  assert.match(namedFunctionSource('addLoginUser'), /window\.electronSession\.addStaffProfile\(name\)/);
  assert.match(namedFunctionSource('addLoginUser'), /result\.profile\?\.role !== 'Front Desk'/);
  assert.match(namedFunctionSource('refreshLoginProfiles'), /window\.electronSession\.listProfiles\(\)/);
  assert.match(namedFunctionSource('selectLoginUser'), /const profile = _loginProfile\(name\)/);
  assert.match(namedFunctionSource('getUserRole'), /_loginProfile\(name\)\?\.role/);
});

test('added Front Desk users appear in task choices without inheriting Carrie or owner access', () => {
  const assignable = namedFunctionSource('getAssignableStaff');
  const carrie = namedFunctionSource('isCarrie');
  assert.match(assignable, /_loginProfiles/);
  assert.match(assignable, /profile\.role !== 'Owner'/);
  assert.match(assignable, /profile\.role === 'Front Desk'/);
  assert.match(carrie, /currentUser\(\) === 'Carrie Gass'/);
  assert.doesNotMatch(carrie, /includes\('carrie'\)/i);
  assert.match(namedFunctionSource('canAccessPage'), /page === 'stepup'\) return isCarrie\(\)/);
  assert.match(namedFunctionSource('saveStepUpReceipts'), /if \(!isCarrie\(\)\)/);
  assert.match(namedFunctionSource('renderStepUp'), /requireStepUpAccess\(\)/);
  assert.match(source, /class="settings-section owner-settings-section" id="owner-ai-settings"/);
  assert.match(source, /id="owner-microsoft-settings"/);
  assert.match(source, /id="owner-sync-settings"/);
  assert.match(namedFunctionSource('applyRolePermissions'), /section\.style\.display = liz \? '' : 'none'/);
  assert.match(source, /id="pref-name" class="form-select" disabled/);
  assert.match(source, /id="pref-role" class="form-select" disabled/);
});

test('task dropdown behavior includes added users at the intended authority levels', () => {
  const profiles = [
    { name: 'Elizabeth Chaves', role: 'Owner' },
    { name: 'Carrie Gass', role: 'Operations & Events' },
    { name: 'Ana Chaves', role: 'Front Desk' },
    { name: "Quinn O'Neil", role: 'Front Desk' },
  ];
  const evaluateFor = current => {
    const sandbox = {
      _loginProfiles: profiles,
      isElizabeth: () => current === 'Elizabeth Chaves',
      isCarrie: () => current === 'Carrie Gass',
    };
    vm.runInNewContext(`${namedFunctionSource('getAssignableStaff')}; this.result = getAssignableStaff();`, sandbox);
    return JSON.parse(JSON.stringify(sandbox.result));
  };
  assert.deepEqual(evaluateFor('Elizabeth Chaves'), ['Carrie Gass', 'Ana Chaves', "Quinn O'Neil"]);
  assert.deepEqual(evaluateFor('Carrie Gass'), ['Ana Chaves', "Quinn O'Neil"]);
  assert.deepEqual(evaluateFor('Ana Chaves'), []);
  assert.deepEqual(evaluateFor("Quinn O'Neil"), []);
});

test('CSV export neutralizes formula-like text without changing ordinary values', () => {
  const sandbox = {};
  vm.runInNewContext(`${namedFunctionSource('ssCsvSafeValue')}; this.safe = ssCsvSafeValue;`, sandbox);
  assert.equal(sandbox.safe('ordinary text'), 'ordinary text');
  assert.equal(sandbox.safe('=HYPERLINK("https://evil.example")'), '\'=HYPERLINK("https://evil.example")');
  assert.equal(sandbox.safe('  +cmd'), "'  +cmd");
  assert.equal(sandbox.safe('@SUM(A1:A2)'), "'@SUM(A1:A2)");
});
