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

test('Firebase password retrieval needs a session, is issue-once, and is cleared after use', () => {
  // Retrieval opened up to every signed-in profile so staff are not silently
  // offline until the owner happens to log in. Writing and clearing the
  // credential are still owner-only, which is the boundary that matters:
  // this releases an existing secret rather than letting anyone create one.
  assert.match(
    mainSource,
    /_secureHandle\('firebase-runtime-config'[\s\S]*?_requireAppRole\(new Set\(\['Owner', 'Operations & Events', 'Front Desk'\]\)\)/
  );
  assert.match(mainSource, /if \(firebaseRuntimeSecretIssued\)[\s\S]*already delivered for this app session/);
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
  // Fix 1: import is an authoritative whole-workbook replacement and must now
  // declare that explicitly, so it cannot be mistaken for an ordinary save.
  assert.match(namedFunctionSource('ssImportBuildProject'),
    /await STORE\.replace\('spreadsheets', normalized, \{ authoritative: 'confirmed workbook import' \}\)/);
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
  // Operations & Events is now an owner-assignable role, so the capability must
  // follow the ROLE. Pinning it to 'Carrie Gass' would deny access to whoever
  // else the owner puts in charge — while still never granting it to a plain
  // Front Desk user, which is what this test actually guards.
  assert.match(carrie, /hasOperationsRole\(\)/);
  assert.doesNotMatch(carrie, /includes\('carrie'\)/i);
  const opsRole = namedFunctionSource('hasOperationsRole');
  assert.match(opsRole, /getUserRole\(currentUser\(\)\) === 'Operations & Events'/);
  assert.doesNotMatch(opsRole, /'Carrie Gass'/);
  // P1-6: Step Up is gated on Owner OR Operations & Events. Pinning these to
  // isCarrie() locked Elizabeth out of her own studio's receipts. Front Desk
  // still gains nothing — that is what this test actually guards.
  assert.match(namedFunctionSource('canAccessPage'), /page === 'stepup'\) return canAccessStepUp\(\)/);
  assert.match(namedFunctionSource('saveStepUpReceipts'), /if \(!canAccessStepUp\(\)\)/);
  const stepUpGate = namedFunctionSource('canAccessStepUp');
  assert.match(stepUpGate, /'Owner'/);
  assert.match(stepUpGate, /'Operations & Events'/);
  assert.doesNotMatch(stepUpGate, /Front Desk/);
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

test('deleted logs never surface in any human-visible view', () => {
  // H-07 tombstones logs instead of removing them, so every read that a person
  // sees must filter them out. Missing one is how a deleted entry kept showing
  // on the dashboard "Last Log" card.
  const visible = namedFunctionSource('getVisibleLogs');
  assert.match(visible, /filter\(l => !l\?\._deleted\)/, 'the helper drops tombstones');

  for (const fn of ['renderLogs', 'renderYesterdayLog', 'editLog']) {
    const body = namedFunctionSource(fn);
    assert.match(body, /getVisibleLogs\(\)/, `${fn} reads through the helper`);
    assert.doesNotMatch(body, /STORE\.get\('logs'/,
      `${fn} must not read the raw log array`);
  }

  // The morning brief card and the AI context window must also be filtered.
  assert.match(source, /const logs = getVisibleLogs\(\);\s*\n\s*const entry = logs\.slice\(\)/,
    'the morning brief last-log card is filtered');
  assert.match(source, /const recentLogs = getVisibleLogs\(\)/,
    'AI context is not fed deleted entries');

  // Mutation and retention paths deliberately keep the raw array so tombstones
  // survive to propagate, and can still be pruned.
  assert.match(namedFunctionSource('deleteLog'), /_deleted: true/);
  assert.doesNotMatch(namedFunctionSource('deleteLog'), /getVisibleLogs\(\)/,
    'deletion must operate on the raw array');
});

// --- §8 functional defects --------------------------------------------------

test('§8: loadSettings has no undefined function call left in it', () => {
  // renderPhoneNumbersList() was called as the last statement of loadSettings()
  // but never defined, so it threw a ReferenceError every time Settings loaded.
  // `await loadSettings()` in disconnectSync() therefore rejected and reported
  // failure after the disconnect had actually succeeded.
  assert.doesNotMatch(script, /renderPhoneNumbersList/,
    'the dead reference is gone, not stubbed');

  // Guard the wider class: every plain `name();` statement inside loadSettings
  // must resolve to something the script actually declares.
  const body = namedFunctionSource('loadSettings');
  const declared = new Set([
    ...[...script.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]),
    ...[...script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].map(m => m[1]),
  ]);
  const missing = [];
  for (const m of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\(\);?$/gm)) {
    if (!declared.has(m[1])) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], 'loadSettings calls only functions that exist');
});

test('§8 item 15: no duplicate top-level function declarations', () => {
  // Two histories independently rewrote the persistence and merge code, so a
  // duplicate declaration would silently shadow the tested implementation.
  const counts = new Map();
  for (const m of script.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(duplicates, [],
    'a redeclared top-level function would shadow the one under test');
});

test('§8: the owner passcode UI states the real length requirement', () => {
  // main.js requires a NEW passcode to be exactly 6 digits
  // (_validOwnerPin(newPin, false)), and changePin() enforces /^\d{6}$/.
  // Advertising "4–6" invited a save the backend would reject. 4–6 remains
  // tolerated only for EXISTING logins.
  assert.match(mainSource, /_validOwnerPin\(request\.newPin, false\)/,
    'main still requires exactly 6 for a new passcode');
  assert.match(namedFunctionSource('changePin'), /\^\\d\{6\}\$/,
    'the renderer enforces the same rule');
  assert.doesNotMatch(source, /4–6 digit|4-6 digit/,
    'no UI text promises a length the backend will reject');
  assert.match(source, /minlength="6" maxlength="6" placeholder="New 6-digit code"/,
    'the settings field matches the rule it is validated against');
  // The first-run label must follow the actual target length, not a literal.
  assert.match(script, /Create a new \$\{_pinTargetLength\}-digit owner passcode/,
    'the creation prompt tracks the length actually collected');
});

// --- P1-2 / P1-7 / P1-8 / P1-9 ----------------------------------------------

test('P1-2: a deleted log that still carries an edit stays operator-reachable', () => {
  // Delete-versus-edit preserves the concurrent edit under a tombstone, but
  // getVisibleLogs() filters every tombstone — so the body existed in storage
  // with no path to it through the app.
  const context = vm.createContext({
    STORE: {
      get: () => ([
        { id: 'a', body: 'live' },
        { id: 'b', body: 'gone', _deleted: true },                                  // no edit to recover
        { id: 'c', body: 'gone', _deleted: true, _conflicts: [{ body: 'edited' }] }, // recoverable
      ]),
    },
    Array,
  });
  vm.runInContext(`
    ${namedFunctionSource('getVisibleLogs')}
    ${namedFunctionSource('getRecoverableDeletedLogs')}
    globalThis.api = { visible: () => getVisibleLogs(), recoverable: () => getRecoverableDeletedLogs() };
  `, context);
  assert.deepEqual([...context.api.visible()].map(l => l.id), ['a'],
    'tombstones stay out of the normal list');
  assert.deepEqual([...context.api.recoverable()].map(l => l.id), ['c'],
    'only tombstones carrying an unresolved edit are offered for recovery');

  // And the UI must actually render and act on them.
  assert.match(source, /id="log-deleted-recovery"/, 'a recovery surface exists');
  assert.match(script, /_renderDeletedLogRecovery\(\)/, 'renderLogs draws it');
  assert.match(script, /onclick="restoreDeletedLog\(/, 'restore action');
  assert.match(script, /onclick="confirmLogDeletion\(/, 'keep-deleted action');
  const confirmFn = script.slice(script.indexOf('async function confirmLogDeletion('));
  assert.match(confirmFn.slice(0, 900), /_mergeResolvedConflictIds\(/,
    'confirming deletion retires the variants so they stop reappearing');
});

test('P1-7: Staff Hub shows the live role, not the shipped built-in role', () => {
  const fn = namedFunctionSource('getProfileStaffDirectory');
  assert.match(fn, /role: profile\.role/,
    'the reconciled role wins over the immutable built-in entry');
  assert.doesNotMatch(fn, /return builtIn \|\|/,
    'returning the built-in entry intact re-introduced the stale role');
});

test('P1-8: lesson check-out is gone, along with every trace of it', () => {
  // Retired with the MindBody API. The regression this replaces guarded a
  // keying bug in code that no longer exists; what matters now is that no part
  // of it survived as dead UI or a dangling call.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const name of [
    'getCheckoutStateKey', 'getCheckoutState', '_lessonCheckoutKey',
    'isLessonCheckedOut', 'setCheckedOut', '_syncMbCheckoutStatus',
    'getCheckoutNeeded', 'checkoutLesson', 'mbCheckoutLesson',
    'updateCheckoutBadge', 'renderDashboardCheckout', 'renderScheduleCheckout',
    'refreshCheckout',
  ]) {
    assert.doesNotMatch(html, new RegExp(name), `${name} still appears in the renderer`);
  }
  for (const marker of [
    'schedule-checkout-list', 'dashboard-checkout-list', 'checkout-badge',
    'stat-checkout', 'btn-checkout', 'Check-Out Status',
  ]) {
    assert.equal(html.includes(marker), false, `${marker} is orphaned markup`);
  }
});

// --- MB161-010: sheet activity was a running total since the sheet existed ----

function activityApi(sheet, storedWindow) {
  const store = new Map();
  if (storedWindow !== undefined) store.set('tmb__ss_activity_window', storedWindow);
  const context = vm.createContext({
    Date, Object, Map, Number, String, Array, JSON,
    ssActiveSheet: () => sheet,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
  vm.runInContext(`
    ${namedFunctionSource('_ssActivityWindow')}
    ${namedFunctionSource('_ssActivityWindowStart')}
    ${namedFunctionSource('_ssContributorSummary')}
    var SS_ACTIVITY_WINDOW_KEY = 'tmb__ss_activity_window';
    var SS_ACTIVITY_WINDOWS = ['today', 'week', 'all'];
    globalThis.api = {
      window: () => _ssActivityWindow(),
      start: (w, now) => _ssActivityWindowStart(w, now),
      summary: since => _ssContributorSummary(since),
    };
  `, context);
  return context.api;
}

const stamp = (by, at) => ({ by, at });

test('MB161-010: the contributor roster counts a window, not everything ever', () => {
  const now = new Date('2026-08-06T15:00:00');
  const sheet = { id: 's1', editedBy: {
    '0,0': stamp('Carrie', new Date('2026-08-06T09:30:00').toISOString()),
    '0,1': stamp('Carrie', new Date('2026-08-06T10:00:00').toISOString()),
    '0,2': stamp('Carrie', new Date('2026-08-03T11:00:00').toISOString()),
    '0,3': stamp('Carrie', new Date('2026-06-01T11:00:00').toISOString()),
    '0,4': stamp('Elizabeth', new Date('2026-07-20T11:00:00').toISOString()),
  } };
  const api = activityApi(sheet);

  const today = api.summary(api.start('today', now));
  assert.equal(today.length, 1, 'only people who did something today');
  assert.equal(today[0].name, 'Carrie');
  assert.equal(today[0].cells.length, 2, 'and only the changes they made today');

  const week = api.summary(api.start('week', now));
  assert.equal(week[0].cells.length, 3, 'seven days reaches back further');

  const all = api.summary(null);
  assert.equal(all.length, 2, 'All still shows everyone');
  assert.equal(all.find(e => e.name === 'Carrie').cells.length, 4);

  // The point of the change: this is the number that used to be on the chip.
  assert.notEqual(today[0].cells.length, all.find(e => e.name === 'Carrie').cells.length);
});

test('MB161-010: "today" is local midnight, not a rolling 24 hours', () => {
  const api = activityApi({ id: 's1', editedBy: {} });
  const now = new Date('2026-08-06T15:00:00');
  const midnight = new Date('2026-08-06T00:00:00');
  assert.equal(api.start('today', now), midnight.getTime(),
    'both Macs reset at a time they can agree on without coordinating');
  assert.equal(api.start('week', now), now.getTime() - 7 * 86400000);
  assert.equal(api.start('all', now), null, 'All means no lower bound');
});

test('MB161-010: an unreadable or absent stamp time is not recent work', () => {
  const now = new Date('2026-08-06T15:00:00');
  const api = activityApi({ id: 's1', editedBy: {
    '0,0': stamp('Carrie', 'not a date'),
    '0,1': stamp('Carrie', undefined),
    '0,2': stamp('Elizabeth', new Date('2026-08-06T09:00:00').toISOString()),
  } });
  const today = api.summary(api.start('today', now));
  // Joined rather than deep-compared: the array is built inside the vm realm.
  assert.equal([...today].map(e => e.name).join(','), 'Elizabeth',
    'a stamp that cannot be dated must not be counted as today’s');
  assert.equal(api.summary(null).length, 2, 'but All still shows it exists');
});

test('MB161-010: the window is a device preference and defaults to today', () => {
  assert.equal(activityApi({}, undefined).window(), 'today');
  assert.equal(activityApi({}, 'week').window(), 'week');
  assert.equal(activityApi({}, 'nonsense').window(), 'today', 'a junk value falls back');
});

test('MB161-010: colours and highlighting stay consistent with the window', () => {
  // Identity colour must come from the UNwindowed roster: switching to Today
  // would otherwise reshuffle everyone's colour.
  assert.match(namedFunctionSource('_ssIdentityRoster'), /_ssContributorSummary\(\)/);
  assert.doesNotMatch(namedFunctionSource('_ssIdentityRoster'), /_ssActivityWindowStart/);

  // The highlight must use the SAME window as the chip, or "4 changes" lights
  // up forty cells.
  assert.match(namedFunctionSource('_ssPaintContributorHighlight'),
    /_ssContributorSummary\(_ssActivityWindowStart\(\)\)/);

  // Narrowing the window can strip the highlighted person of every cell, which
  // would dim the entire grid and highlight nothing.
  assert.match(namedFunctionSource('ssSetActivityWindow'), /_ssHighlightedContributor = null/);
});

test('MB161-010: per-cell stamps are not deleted by the window', () => {
  // "Who last changed B4?" has to keep working for old edits. Nothing in the
  // window code may write to the workbook.
  for (const name of ['_ssActivityWindow', '_ssActivityWindowStart', '_ssContributorSummary']) {
    const fn = namedFunctionSource(name);
    assert.doesNotMatch(fn, /delete /, `${name} must not remove stamps`);
    assert.doesNotMatch(fn, /editedBy\[/, `${name} must not write stamps`);
  }
  // The stamp shown for the selected cell is read straight from the sheet with
  // no window applied.
  assert.match(namedFunctionSource('ssRenderActivityBar'),
    /sheet\?\.editedBy\?\.\[ssKey\(_ssSelR, _ssSelC\)\]/);
});

test('P1-9: an open Morning Brief refreshes when its data arrives', () => {
  const fn = namedFunctionSource('_refreshOpenBriefing');
  assert.match(fn, /classList\.contains\('hidden'\)/,
    'it only re-renders while the modal is actually open');
  assert.match(fn, /showBriefing\(\)/);
  const refresh = namedFunctionSource('_refreshForSyncKey');
  assert.match(refresh, /_refreshOpenBriefing\(\)/,
    'restored logs/tasks re-render the open brief instead of leaving it stale');
});

// --- Field findings: receipt autosave and truthful sync status --------------

test('receipts reach history without pressing Save', () => {
  // Elizabeth and Carrie should not have to remember a Save button for a
  // receipt they have already emailed or exported.
  assert.match(script, /async function _stepUpPersistReceipt\(/, 'a shared persist step exists');
  assert.match(namedFunctionSource('stepUpSaveReceipt'), /_stepUpPersistReceipt\(\{ silent: false \}\)/,
    'the manual button reuses it');

  // Generating a receipt implies keeping it.
  for (const fn of ['stepUpEmailReceipt', 'stepUpDownloadPDF']) {
    assert.match(namedFunctionSource(fn), /await _stepUpEnsureSaved\(\)/,
      `${fn} persists the receipt before generating it`);
  }
  assert.match(script, /function stepUpScheduleAutoSave\(/, 'typing schedules an autosave');
  assert.match(source, /oninput="stepUpScheduleAutoSave\(\)"/, 'and fields are wired to it');

  const persist = script.slice(script.indexOf('async function _stepUpPersistReceipt('));
  const body = persist.slice(0, persist.indexOf('\nasync function ', 1));
  assert.match(body, /STORE\.mutate\('step_up_receipts'/,
    'receipts merge into the reconciled list rather than replacing it');
  assert.match(body, /_newRecordId\(\)/, 'collision-resistant id, not Date.now()');
  assert.match(body, /if \(!receipts\.some\(r => String\(r\.id\) === String\(newId\)\)\)/,
    'autosave running twice must not duplicate the receipt');
  // Silence is only for success — a failed autosave must still be visible.
  assert.match(body, /showToast\(`Receipt was not saved/, 'autosave failures surface');
});

test('sync status is always visible and never sits on Connecting forever', () => {
  const setStatus = namedFunctionSource('setSyncStatus');
  // 'off' was show:false, so a profile that could not reach cloud sync showed
  // no badge at all — indistinguishable from "everything is fine".
  assert.match(setStatus, /off:\s+\{ dot: '#aaaaaa', label: 'Local only',[^}]*show: true/,
    'local-only is shown, not hidden');
  assert.match(setStatus, /offline:\s+\{[^}]*show: true/, 'offline is a distinct visible state');
  assert.match(setStatus, /Offline — saved on this Mac only/,
    'Settings distinguishes no-network from a broken configuration');

  // Firebase auth can hang indefinitely; the badge must still resolve.
  assert.match(script, /const SYNC_CONNECT_TIMEOUT_MS = \d+/, 'the sign-in is bounded');
  const init = namedFunctionSource('initFirebase');
  assert.match(init, /Promise\.race\(\[/, 'sign-in races a timeout');
  assert.match(init, /signInWithEmailAndPassword\(email, password\)/);
  assert.match(init, /SYNC_CONNECT_TIMEOUT_MS/);
  assert.match(init, /code: navigator\.onLine === false \? 'SYNC_OFFLINE'/,
    'a dead network is reported as offline, not as a generic failure');
  assert.match(init, /setSyncStatus\(offline \? 'offline' : 'error'\)/,
    'losing the network must not read the same as a broken config');
});

test('a failed sync says why, on screen, where there is no console', () => {
  // Packaged builds disable devTools, so console.warn is invisible to whoever
  // is actually on shift. A red badge alone is indistinguishable from a red
  // badge for any other reason.
  const init = namedFunctionSource('initFirebase');
  assert.match(init, /catch \(pendingError\)/);
  assert.match(init, /uidEl\.textContent =\s*\n?\s*'Signed in as '/,
    'the upload failure names itself in the settings panel');
  assert.match(init, /pendingError\?\.message \|\| String\(pendingError\)/,
    'and carries the real reason, not a generic string');
  assert.match(init, /pendingError\?\.code \? ' \(' \+ pendingError\.code \+ '\)' : ''/,
    'plus the Firebase error code, which is what makes it searchable');

  // The connect path must clear the stale "must be in memberUids" hint once
  // that is no longer the situation.
  assert.match(init, /if \(uidEl && !_portablePinStale\) \{[\s\S]*?'Connected as '/,
    'success replaces the setup hint rather than leaving it on screen');

  // Same treatment for the outer failure.
  assert.match(init, /'Sync connection failed: ' \+ \(e\?\.message \|\| String\(e\)\) \+\s*\n?\s*\(e\?\.code \? ' \(' \+ e\.code \+ '\)' : ''\)/,
    'connection failures carry their code too');

  // The underlying flush must keep producing per-key detail for that line to
  // be worth showing at all.
  const flush = namedFunctionSource('_flushSyncDeliveries');
  assert.match(flush, /throw new Error\(problems\.join\('; '\)\)/);
});

// --- Live collaborator presence ---------------------------------------------

test('presence never rides on the data path that protects real edits', () => {
  const publish = namedFunctionSource('_ssPresencePublish');
  const ref = namedFunctionSource('_ssPresenceRef');
  assert.match(ref, /collection\('presence'\)/, 'its own subcollection');
  // A cursor heartbeat must never touch a revision counter, a pending record,
  // or the store — those are what make real edits recoverable.
  for (const forbidden of [/STORE\./, /revision/i, /_writePendingSyncRecord/, /_queueEncryptedWrite/]) {
    assert.doesNotMatch(publish, forbidden, `presence stays off the data path: ${forbidden}`);
  }
  assert.doesNotMatch(namedFunctionSource('_ssPresenceDecode'), /STORE\./);
});

test('presence is encrypted, so staff names never sit in Firestore as plaintext', () => {
  const publish = namedFunctionSource('_ssPresencePublish');
  assert.match(publish, /_aesEncryptWithKey\(JSON\.stringify\(\{/, 'the payload is encrypted');
  assert.match(publish, /_syncEncKey/, 'with the shared cloud key, so peers can read it');
  assert.match(publish, /format: SYNC_ENVELOPE_FORMAT/);
  // The name must be inside the ciphertext, not a sibling field.
  const setCall = publish.slice(publish.indexOf('.set({'));
  assert.doesNotMatch(setCall.slice(0, 240), /name/, 'no plaintext name on the document');

  const decode = namedFunctionSource('_ssPresenceDecode');
  assert.match(decode, /keyId !== localStorage\.getItem\('tmb__sync_key_id'\)/,
    'a payload from a different key is ignored rather than guessed at');
  assert.match(decode, /_aesDecryptWithKey/);
});

test('presence writes are rationed, because this studio is on the free tier', () => {
  const publish = namedFunctionSource('_ssPresencePublish');
  // A plain interval would burn the daily Firestore quota on cursors.
  assert.match(publish, /signature === _ssPresenceLastSignature && elapsed < SS_PRESENCE_HEARTBEAT_MS/,
    'an unmoved cursor does not write');
  assert.match(publish, /if \(!_ssPresenceCanPublish\(\) \|\| _ssPresenceWriting\) return false/,
    'and overlapping writes are not queued up');
  const canPublish = namedFunctionSource('_ssPresenceCanPublish');
  assert.match(canPublish, /page-spreadsheets'\)\?\.classList\.contains\('active'\)/,
    'nothing is published while the page is closed');
  assert.match(source, /if \(page === 'spreadsheets'\) \{ initSpreadsheet\(\); ssPresenceStart\(\); \}\s*\n\s*else ssPresenceStop\(\);/,
    'leaving the page stops the heartbeat');
});

test('a cursor disappears on its own when a Mac stops reporting', () => {
  // A Mac that loses power never gets to say goodbye, so the roster cannot
  // depend on the delete call arriving.
  const live = namedFunctionSource('_ssLivePresencePeers');
  assert.match(live, /peer\.updatedMs >= cutoff/, 'stale entries age out at render time');
  assert.match(source, /const SS_PRESENCE_TTL_MS = \d+/);
  const decode = namedFunctionSource('_ssPresenceDecode');
  assert.match(decode, /if \(!Number\.isFinite\(updatedMs\)\) return null/,
    'an entry with no server timestamp cannot masquerade as live');
  // Still make the common case clean.
  assert.match(namedFunctionSource('ssPresenceStop'), /_ssPresenceRef\(\)\.delete\(\)/);
  assert.match(source, /addEventListener\('beforeunload', \(\) => \{ try \{ ssPresenceStop\(\)/);
});

test('a broken presence feature never breaks editing', () => {
  const publish = namedFunctionSource('_ssPresencePublish');
  assert.match(publish, /console\.warn\('Presence write skipped:'/,
    'a failed heartbeat is logged, not surfaced as a sync failure');
  assert.doesNotMatch(publish, /showToast/, 'and never interrupts the person typing');
  assert.match(namedFunctionSource('_ssPresenceSubscribe'), /console\.warn\('Presence listener/);
  // Every call site from the editor is guarded.
  const toolbar = namedFunctionSource('ssUpdateToolbar');
  assert.match(toolbar, /try \{ _ssPresencePublish\(\); \} catch \(_\) \{\}/);
  assert.match(toolbar, /try \{ _ssPaintPresenceCursors\(\); \} catch \(_\) \{\}/);
});

test('the presence rules keep it disposable without loosening the data rules', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  assert.match(rules, /match \/presence\/\{deviceId\}/);
  assert.match(rules, /allow create, update: if isStudioMember\(studioCode\) &&\s*\n\s*validPresenceDeviceId\(deviceId\) && validPresenceWrite\(\)/);
  // Every other collection is bounded by a key allowlist; this one takes an id
  // from the client, so its shape has to be constrained too.
  assert.match(rules, /function validPresenceDeviceId\(deviceId\) \{\s*\n\s*return deviceId\.matches\('dev_\[A-Za-z0-9_-\]\{8,72\}'\);/);
  // Client and rules must agree, or writes are rejected server-side and
  // presence silently stops working.
  assert.match(source, /!\/\^dev_\[A-Za-z0-9_-\]\{8,72\}\$\/\.test\(id\)/);
  // Presence is the one thing that SHOULD be deletable; data must not become so.
  const presenceBlock = rules.slice(rules.indexOf('match /presence/{deviceId}'));
  assert.match(presenceBlock, /allow delete: if isStudioMember\(studioCode\)/);
  const dataBlock = rules.slice(rules.indexOf('match /data/{keyId}'), rules.indexOf('match /presence/'));
  assert.match(dataBlock, /allow delete: if false/, 'data documents stay undeletable');
  // Server time only, or a stale cursor could claim to be live forever.
  assert.match(rules, /request\.resource\.data\.updated == request\.time/);
  assert.match(rules, /request\.resource\.data\.ciphertext\.size\(\) <= 4000/, 'and bounded');
});

// --- Contributor summary and highlight ---------------------------------------

test('the sheet says who changed it, without waiting to be asked', () => {
  // The first version only showed a stamp for the selected cell, so a sheet
  // full of tracked edits looked identical to one with none.
  const summary = namedFunctionSource('_ssContributorSummary');
  assert.match(summary, /sheet\?\.editedBy \|\| \{\}/, 'derived from the stamps');
  assert.doesNotMatch(source, /editCount|_ssChangeCounts/,
    'no second running total that could disagree with the stamps');
  assert.match(summary, /Date\.parse\(b\.lastAt\) - Date\.parse\(a\.lastAt\)/, 'most recent first');

  const render = namedFunctionSource('ssRenderActivityBar');
  assert.match(render, /nameLine\.textContent = entry\.name/, 'names the person');
  assert.match(render, /change\$\{count === 1 \? '' : 's'\} · last /, 'with the count and when they last touched it');
  // MB161-010: built as nodes. A profile name is user-supplied text and this is
  // the one place it lands in the sidebar.
  assert.doesNotMatch(render, /innerHTML\s*[+]?=\s*`[^`]*\$\{entry\./,
    'the name must never be interpolated into markup');
  assert.match(render, /No tracked edits on this sheet yet/,
    'an empty sheet says so rather than showing nothing and looking broken');
  assert.match(render, /bar\.style\.display = 'flex'/, 'the panel is always present once a sheet is open');
  // It lives beside the grid, not under it: a long contributor list must not
  // push the sheet down and force scrolling to reach the tabs.
  assert.match(source, /<aside id="ss-activity-bar">/);
  assert.match(source, /#ss-activity-bar \{[^}]*flex:0 0 212px/);
  assert.match(source, /#ss-editor-main \{ display:flex;flex:1;min-height:0/);
  assert.match(namedFunctionSource('_ssPresenceRenderRoster'), /Just you on this sheet/,
    'an empty roster explains itself rather than sitting blank');
});

test('clicking a contributor highlights exactly their cells, and toggles off', () => {
  const toggle = namedFunctionSource('ssToggleContributorHighlight');
  assert.match(toggle, /_ssHighlightedContributor === name \? null : name/, 'a second click clears it');

  const paint = namedFunctionSource('_ssPaintContributorHighlight');
  assert.match(paint, /\[data-contributor-highlight\]/, 'a repaint clears the previous one first');
  assert.match(paint, /entry\.cells/, 'and paints only that person’s cells');
  // Must not fight the live collaborator cursor, which owns `outline`.
  assert.match(paint, /style\.boxShadow = `inset 0 0 0 3px \$\{color\}, 0 0 8px \$\{color\}`/,
    'uses box-shadow so a cell can show both a cursor and a highlight');
  // A ring alone vanished into the schedule's own fill colours.
  assert.match(paint, /cell\.style\.opacity = '0\.28'/, 'everything else fades back');
  assert.match(paint, /\[data-contributor-highlight\], \[data-contributor-dim\]/,
    'and both effects are cleared together, so nothing stays faded');
  assert.doesNotMatch(paint, /style\.outline\b/, 'outline belongs to presence');

  // Rebuilding the table drops inline styles, so both repaints must follow it.
  const toolbar = namedFunctionSource('ssUpdateToolbar');
  assert.match(toolbar, /try \{ _ssPaintContributorHighlight\(\); \} catch \(_\) \{\}/);
  assert.match(toolbar, /try \{ _ssPaintPresenceCursors\(\); \} catch \(_\) \{\}/);

  // One person, one colour, everywhere they appear.
  assert.match(paint, /_ssPresenceColor\(entry\.name\)/);
  assert.match(namedFunctionSource('ssRenderActivityBar'), /_ssPresenceColor\(entry\.name\)/);
});

test('the activity panel collapses, and remembers that it was collapsed', () => {
  assert.match(source, /<button id="ss-activity-toggle" type="button" onclick="ssToggleActivityPanel\(\)"><\/button>/);
  assert.match(source, /#ss-activity-bar\.ss-collapsed \{ width:30px/);
  assert.match(source, /#ss-activity-bar\.ss-collapsed #ss-activity-content \{ display:none/);

  const toggle = namedFunctionSource('ssToggleActivityPanel');
  assert.match(toggle, /localStorage\.setItem\(SS_ACTIVITY_COLLAPSED_KEY/,
    'the preference survives a restart rather than resetting every session');
  assert.match(namedFunctionSource('_ssActivityCollapsed'), /catch \(_\) \{ return false; \}/,
    'and unreadable storage falls back to visible instead of throwing');

  const apply = namedFunctionSource('_ssApplyActivityPanelState');
  // Hiding the panel must not hide the one thing you would not want hidden.
  assert.match(apply, /const peers = collapsed \? _ssLivePresencePeers\(\) : \[\]/);
  assert.match(apply, /dot\.style\.background = _ssPresenceColor\(peers\[0\]\.name\)/,
    'a collapsed panel still shows that someone else is editing');
  assert.match(apply, /\} else if \(dot\) \{\s*\n\s*dot\.remove\(\);/,
    'and the indicator goes away when they do');
  assert.match(namedFunctionSource('ssRenderActivityBar'), /_ssApplyActivityPanelState\(\)/,
    'the collapsed state is reapplied after every render');
});

test('no two people on a sheet share a colour', () => {
  // Hashing names collided: with five staff and eight colours, three of them
  // came out orange and the colour identified nobody.
  const color = namedFunctionSource('_ssPresenceColor');
  assert.match(color, /const roster = _ssIdentityRoster\(\)/);
  assert.match(color, /const index = roster\.indexOf\(seed\)/, 'assigned by position, not by hash');

  const roster = namedFunctionSource('_ssIdentityRoster');
  assert.match(roster, /\.sort\(\(a, b\) => a\.localeCompare\(b\)\)/,
    'ordered the same on every Mac, so a person is the same colour on both');
  assert.match(roster, /for \(const peer of _ssPresencePeers\) names\.add\(peer\.name\)/,
    'presence and past edits draw from one roster, so a person has one colour');

  // Exercise it: distinct people must come out distinct.
  const palette = [...source.matchAll(/'(#[0-9a-f]{6})'/g)].map(m => m[1]);
  assert.ok(palette.length >= 12, 'enough colours for a studio');
  const context = {
    _ssContributorSummary: () => [
      { name: 'Emma Minnetto' }, { name: 'Carrie Gass' }, { name: 'Kylie' },
      { name: 'Elizabeth Chaves' }, { name: 'Ana Chaves' },
    ],
    _ssPresencePeers: [],
    _ssAttributionActor: () => null,
  };
  vm.runInNewContext(
    `${source.match(/const SS_PRESENCE_COLORS = \[[\s\S]*?\];/)[0]}\n` +
    `${namedFunctionSource('_ssIdentityRoster')}\n${namedFunctionSource('_ssPresenceColor')}\n` +
    `globalThis.out = _ssContributorSummary().map(c => _ssPresenceColor(c.name));`,
    context
  );
  const assigned = [...context.out];
  assert.equal(new Set(assigned).size, assigned.length,
    `every person got their own colour, got ${JSON.stringify(assigned)}`);
});

test('a mistyped Firebase API key is diagnosed here, not by a round trip', () => {
  // "auth/api-key-not-valid" tells you the key is wrong and nothing about why,
  // and the field was masked so nobody could proof-read their own typing.
  const context = {};
  vm.runInNewContext(
    `${source.match(/const FIREBASE_API_KEY_PATTERN = .*/)[0]}\n` +
    `${namedFunctionSource('describeFirebaseApiKeyProblem')}\n` +
    `globalThis.check = k => describeFirebaseApiKeyProblem(k);`,
    context
  );
  const check = context.check;
  const valid = 'AIza' + 'B'.repeat(35);
  assert.equal(check(valid), null, 'a well-formed key passes');
  assert.equal(check(valid.slice(0, 30)), 'A Firebase API Key is 39 characters; this one is 30. It looks truncated — re-copy the whole value.');
  assert.match(check('1:284007458:web:c153cd92'), /starts with “AIza”/, 'pasting the App ID is named as such');
  assert.match(check('AIza B'.padEnd(39, 'B')), /contains a space/);
  assert.match(check(''), /empty/);

  // The check has to run before the network call, or it adds nothing.
  const save = namedFunctionSource("saveFirebaseSettings");
  const problemAt = save.indexOf('describeFirebaseApiKeyProblem(apiKey)');
  const configureAt = save.indexOf('window.electronFirebase.configure');
  assert.ok(problemAt > -1 && configureAt > -1 && problemAt < configureAt);

  // And the field can be read back, since this value is not a secret.
  assert.match(source, /onclick="toggleFirebaseKeyVisibility\(\)"/);
  const toggle = namedFunctionSource('toggleFirebaseKeyVisibility');
  assert.match(toggle, /field\.type = showing \? 'password' : 'text'/);
  assert.match(source, /id="firebase-api-key" class="form-input" placeholder="AIzaSy\.\.\."\s*\n?\s*spellcheck="false"/,
    'and autocorrect cannot quietly rewrite it');
});

test('correcting Firebase credentials takes effect without restarting the app', () => {
  // Reported from real use: the API key was fixed in Settings, stored, and
  // displayed correctly, yet every attempt still failed with
  // auth/api-key-not-valid. Credentials are baked into the Firebase app
  // instance at initializeApp time, and the instance was only rebuilt when the
  // projectId changed — so a corrected key was never actually used.
  const init = namedFunctionSource('initFirebase');
  assert.match(init, /const staleConfig = !!existing && \[/);
  for (const field of ['projectId', 'apiKey', 'appId', 'authDomain']) {
    assert.match(init, new RegExp(`\\['${field}',`), `${field} change forces a rebuild`);
  }
  assert.match(init, /if \(staleConfig\) \{\s*\n\s*await existing\.delete\(\);/,
    'the stale instance is torn down, not reused');
  assert.doesNotMatch(init, /existing\.options\?\.projectId !== projectId/,
    'the projectId-only comparison is gone');

  // Exercise the comparison itself.
  const compare = (existingOptions, next) => {
    const fields = [
      ['projectId', next.projectId], ['apiKey', next.apiKey],
      ['appId', next.appId || undefined], ['authDomain', next.authDomain],
    ];
    return fields.some(([f, v]) => (existingOptions?.[f] || undefined) !== (v || undefined));
  };
  const live = { projectId: 'p', apiKey: 'AIzaGOOD', appId: '1:2:web:3', authDomain: 'p.firebaseapp.com' };
  assert.equal(compare(live, live), false, 'an unchanged config reuses the instance');
  assert.equal(compare(live, { ...live, apiKey: 'AIzaFIXED' }), true, 'a corrected key rebuilds it');
  assert.equal(compare(live, { ...live, appId: '9:9:web:9' }), true);
  assert.equal(compare(live, { ...live, projectId: 'other' }), true);
  // Absent and empty must not read as a difference, or every connect rebuilds.
  assert.equal(compare({ ...live, appId: undefined }, { ...live, appId: '' }), false);
});

test('a remote edit does not throw you out of the project you have open', () => {
  // Reported from real use: two Macs in the same sheet, and the moment one
  // saved, the other was dumped back to the project list. Every arriving
  // workbook called ssGoHome() — written so the "Checking the cloud" card gets
  // replaced on first arrival, but with live collaboration that fires
  // constantly.
  const refresh = namedFunctionSource('_refreshForSyncKey');
  // MB161-012: the branch now also fires for a single project document
  // arriving on its own key.
  const start = refresh.indexOf("if (key === 'spreadsheets' || _ssIsProjectSyncKey(key))");
  assert.notEqual(start, -1, 'the spreadsheet refresh branch is still there');
  const block = refresh.slice(start);
  assert.match(block, /const openProjectSurvived = editorOpen &&/);
  assert.match(block, /if \(openProjectSurvived\) ssRender\(\);/, 'an open project re-renders in place');
  assert.match(block, /else ssGoHome\(\);/, 'the home card is still refreshed when none is open');
  assert.doesNotMatch(
    block,
    /classList\.contains\('active'\) && !_ssEditCell\) ssGoHome\(\);/,
    'the unconditional bounce is gone'
  );

  // Which project and sheet you are looking at rides inside the shared
  // workbook, so without this the last person to save drags everyone else to
  // whatever they had open.
  assert.match(block, /const stillPresent = \(_ssData\.projects \|\| \[\]\)\.find/);
  assert.match(block, /_ssData\.activeProject = openProjectId;/, 'your project stays yours');
  assert.match(block, /stillPresent\.activeId = openSheetId;/, 'and so does your sheet');
  // A project deleted on the other Mac has to send you home; there is nothing
  // left to render.
  assert.match(block, /\.some\(project => project\.id === _ssData\.activeProject\)/);
  // Mid-edit is still left alone.
  assert.match(block, /if \(pageActive && !_ssEditCell\)/);
});

test('the sync badge can never come to rest on Connecting', () => {
  // Reported from real use: opening the app on a staff profile left
  // "Connecting…" on screen indefinitely. "Connecting" is a promise that
  // something happens next; if a path returns without resolving it, the person
  // has no idea whether their work is reaching the cloud.
  const wrapper = namedFunctionSource('initFirebase');
  assert.match(wrapper, /return await _initFirebaseInner\(\);/);
  assert.match(wrapper, /\} finally \{/, 'the guarantee holds even when a path throws');
  assert.match(wrapper, /if \(_syncStatusState === 'connecting'\)/);
  assert.match(wrapper, /setSyncStatus\(_syncReady && _firestoreDb && _firebaseAuth\?\.currentUser \? 'live' : 'error'\)/,
    'and it resolves to what is actually true, not to a guess');

  // Reusing an owner session is a success and has to say so — this path used to
  // return true without touching the badge at all.
  const inner = namedFunctionSource('_initFirebaseInner');
  assert.match(inner, /if \(!isElizabeth\(\) && _syncReady && _firestoreDb && _firebaseAuth\?\.currentUser\) \{/);
  assert.match(inner, /setSyncStatus\(_portablePinStale \? 'error' : 'live'\);\s*\n\s*return true;/);

  // The tracker has to be updated before setSyncStatus can bail on a missing
  // chip, or a renderer without one looks permanently stuck.
  const setStatus = namedFunctionSource('setSyncStatus');
  const assignAt = setStatus.indexOf('_syncStatusState = state;');
  const bailAt = setStatus.indexOf('if (!chip) return;');
  assert.ok(assignAt > -1 && bailAt > -1 && assignAt < bailAt);
});

test('selecting text inside a cell does not destroy the cell being edited', () => {
  // Reported from real use: the caret could not be placed inside a word, so the
  // only way to change a cell was to clear it and retype. Dragging inside the
  // open cell was being read as a cell range-selection, which re-rendered the
  // grid and threw away the contenteditable mid-gesture.
  const over = namedFunctionSource('ssGridMouseOver');
  assert.match(over, /if \(_ssEditCell\) return;/, 'an open editor owns the drag');
  const guardAt = over.indexOf('if (_ssEditCell) return;');
  const renderAt = over.indexOf('ssRenderGrid()');
  assert.ok(guardAt > -1 && renderAt > -1 && guardAt < renderAt,
    'and the guard comes before anything that rebuilds the grid');

  // A double-click leaves a drag origin behind; the next mouse move would
  // otherwise start a range selection over the cell being typed in.
  const start = namedFunctionSource('ssStartEdit');
  assert.match(start, /_ssIsSelecting = false;\s*\n\s*_ssDragOrigin = null;/);

  // Clicking inside the open cell must still fall through to the browser so the
  // caret lands where it was clicked.
  assert.match(namedFunctionSource('ssGridMouseDown'),
    /if \(_ssEditCell && _ssEditCell\.r===r && _ssEditCell\.c===c\) return;/);
  // And arrow keys must reach the cell rather than moving the selection. The
  // grid key handler is an inline listener, so check it where it lives.
  const arrowHandler = script.slice(
    script.lastIndexOf('if (_ssEditCell) return;', script.indexOf("e.key==='ArrowLeft'")),
    script.indexOf("e.key==='ArrowLeft'")
  );
  assert.match(arrowHandler, /if \(_ssEditCell\) return;/,
    'cell navigation stands down while a cell is open');
});

test('derived passcode material is never compared with ===', () => {
  // Comparing a PBKDF2 output with === leaks how many leading characters
  // matched. The main process already used timingSafeEqual for the
  // authoritative check; the renderer path was the one place that did not.
  const compare = namedFunctionSource('_constantTimeEquals');
  assert.match(compare, /const length = Math\.max\(left\.length, right\.length\)/,
    'the loop count does not depend on where the first difference is');
  assert.match(compare, /let difference = left\.length \^ right\.length/,
    'and a length mismatch is folded in rather than returning early');
  assert.doesNotMatch(compare, /return (true|false);/, 'no early exit at all');

  const context = {};
  vm.runInNewContext(`${compare}\nglobalThis.eq = _constantTimeEquals;`, context);
  assert.equal(context.eq('abc', 'abc'), true);
  assert.equal(context.eq('abc', 'abd'), false);
  assert.equal(context.eq('abc', 'abcd'), false, 'a prefix is not a match');
  assert.equal(context.eq('', ''), true);
  assert.equal(context.eq(null, ''), true, 'null and empty both normalise');

  // Every passcode comparison must go through it.
  for (const call of [
    /_constantTimeEquals\(await _hashPin\(pin, salt, state\.iterations\), state\.hash\)/,
    /_constantTimeEquals\(\s*\n\s*await _hashPin\(_pinBuffer, _b64ToBytes\(psB64\), iterations\), stored\)/,
    /_constantTimeEquals\(_pinBuffer, stored\)/,
  ]) {
    assert.match(script, call, `passcode comparison uses the constant-time helper: ${call}`);
  }
  assert.doesNotMatch(script, /await _hashPin\([^)]*\) === /, 'no derived material compared with ===');
});

test('double-clicking a cell enters edit mode even though selecting rebuilds the grid', () => {
  // Reproduced directly on the machine: double-click never opened the editor.
  // Pressing Left afterwards moved the cell SELECTION, which only happens when
  // no editor is open. Cause: ssGridMouseDown rebuilds the entire table on
  // every mousedown, so the two clicks of a double-click land on different DOM
  // nodes and the browser never dispatches dblclick to the cell. Editing text
  // that was already in a cell was impossible.
  const down = namedFunctionSource('ssGridMouseDown');
  assert.match(down, /const secondClick = _ssLastCellMouseDown\.r === r && _ssLastCellMouseDown\.c === c/,
    'the second click is recognised without the browser event');
  assert.match(down, /\(now - _ssLastCellMouseDown\.at\) <= SS_DOUBLE_CLICK_MS/);
  assert.match(down, /if \(secondClick\) \{[\s\S]*?ssStartEdit\(r, c, null, \{ x: e\.clientX, y: e\.clientY \}\)/,
    'and it opens the editor at the click point');
  assert.match(down, /_ssLastCellMouseDown\.at = 0;.*third click/,
    'a third click does not immediately re-trigger');

  // Order matters: the detection must happen before the selection rebuild,
  // which is the very thing that destroys the browser's dblclick pairing.
  // Aim at the MAIN path's selection specifically. Probing for the first
  // `_ssSelR=r;_ssSelC=c;` anywhere in the function is too loose: the checkbox
  // branch added later sets the selection too, and it legitimately runs before
  // the detection, which made this read as a regression when nothing had
  // regressed. The line that matters is the one the rebuild follows.
  const detectAt = down.indexOf('const secondClick');
  const selectAt = down.indexOf('_ssSelR=r;_ssSelC=c;_ssSelR2=r;_ssSelC2=c;\n  _ssIsSelecting=false;');
  assert.ok(detectAt > -1, 'the detection exists');
  assert.ok(selectAt > -1, 'and so does the selection rebuild it must precede');
  assert.ok(detectAt < selectAt, 'detection comes first');

  // MB161-020: ticking a box is handled before the double-click detection, so a
  // second click ticks it back rather than opening a text editor over the word
  // TRUE. That is what Google does, and it is why the probe above had to be
  // made specific rather than this branch moved.
  const checkAt = down.indexOf("e.target.dataset?.cb === '1'");
  assert.ok(checkAt > -1 && checkAt < detectAt);

  // The fallback path must not restart an edit already begun, or it throws away
  // the caret that was just positioned.
  const dbl = namedFunctionSource('ssGridDblClick');
  assert.match(dbl, /if \(_ssEditCell && _ssEditCell\.r === r && _ssEditCell\.c === c\) return;/);

  // Clicking inside the open editor still falls through to the browser so the
  // caret lands where it was clicked.
  assert.match(down, /if \(_ssEditCell && _ssEditCell\.r===r && _ssEditCell\.c===c\) return;/);
});

test('cells clip and the formula bar carries the full value', () => {
  // A schedule is read by scanning rows and columns. One long note growing its
  // cell pushed every neighbouring row out of alignment, so cells now hold a
  // fixed height and the whole value lives in the formula bar.
  // The text lives in .ss-cell-inner, not directly in the td — setting
  // white-space on the td never applied to it, which is why two earlier
  // attempts at this changed nothing.
  assert.match(source, /\.ss-cell-inner \{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis;/);
  // Anchored to the base rule: the merged-cell override below it legitimately
  // does wrap and must not make this pass or fail by accident.
  assert.doesNotMatch(source, /\n    \.ss-cell-inner \{[^}]*white-space:pre-wrap/,
    'the wrapping rule that actually governed cell text is gone');
  assert.match(source, /#ss-grid td\[rowspan\]:not\(\[rowspan="1"\]\) \.ss-cell-inner,/,
    'merged cells still wrap, since that is the point of merging');

  // A merged cell was deliberately given the room, so it may use it.

  // The formula bar was styled and wired but never placed in the document,
  // which is why selecting a cell never showed anything.
  // Full width on its own row under the palette: a long note squeezed beside
  // the cell reference is no more readable than the clipped cell was.
  assert.match(source, /<div id="ss-formula-row">[\s\S]*?<input id="ss-formula-bar"[\s\S]*?onkeydown="ssFormulaBarKey\(event\)"/);
  assert.match(source, /#ss-formula-row \{[^}]*display:flex/);
  const toolbar = namedFunctionSource('ssUpdateToolbar');
  assert.match(toolbar, /const fb = document\.getElementById\('ss-formula-bar'\)/);
  assert.match(toolbar, /if \(fb && document\.activeElement !== fb\) fb\.value = cell\.v \|\| ''/,
    'it follows the selection without fighting someone typing in it');
  assert.match(namedFunctionSource('ssFormulaBarKey'), /ssBoundedCellValue\(e\.target\.value\)/,
    'and editing through it is bounded like any other cell write');

  // The cell being typed in must still show what is being typed.
  // The editor stays one row tall too — letting it grow was the remaining
  // source of expansion while typing.
  assert.match(source, /#ss-grid td\.ss-editing \.ss-cell-input \{\s*\n\s*white-space:pre;overflow-x:auto;overflow-y:hidden;/);
  assert.match(source, /height:100%;min-height:0;/);
  assert.doesNotMatch(source, /white-space:pre-wrap;\s*\n?\s*word-wrap:break-word/,
    'the wrapping editor rule is gone');
});

// ── MB161-014: Google Sheets, read-only, in the renderer ────────────────────

test('MB161-014: the renderer never talks to Google directly', () => {
  // Every Google call goes through main via IPC. That is why the CSP does not
  // need to be widened for sheets.googleapis.com — and it must stay that way,
  // because a renderer fetch would put an access token in the renderer.
  const csp = source.match(/content="default-src[^"]*"/)[0];
  assert.doesNotMatch(csp, /sheets\.googleapis\.com/,
    'the renderer has no business reaching Google');
  assert.doesNotMatch(csp, /oauth2\.googleapis\.com/);
  assert.doesNotMatch(csp, /accounts\.google\.com/);

  for (const name of ['connectGoogleSheets', 'ssGoogleLookup', 'ssGoogleImportTab']) {
    const fn = namedFunctionSource(name);
    assert.doesNotMatch(fn, /\bfetch\s*\(/, `${name} must not fetch Google itself`);
    assert.doesNotMatch(fn, /XMLHttpRequest/);
  }
});

test('MB161-014: the PKCE verifier never leaves the renderer', () => {
  const connect = namedFunctionSource('connectGoogleSheets');
  assert.match(connect, /crypto\.subtle\.digest\('SHA-256'/,
    'only the hash of the verifier is sent to Google');
  assert.match(connect, /beginAuth\(\{ codeChallenge: challenge \}\)/,
    'begin receives the challenge, not the verifier');
  assert.match(connect, /completeAuth\(\{ state: payload\?\.state, codeVerifier: verifier \}\)/,
    'the verifier is only revealed to main at exchange time, to prove the same client started it');
});

test('MB161-014: the client secret field is cleared after saving', () => {
  const save = namedFunctionSource('saveGoogleCredentials');
  assert.match(save, /secretField\.value = ''/,
    'a secret should not sit in a DOM input after it has been stored in the vault');
  assert.match(save, /type="password"/.source ? /setCredentials/ : /setCredentials/);
  assert.match(source, /id="google-client-secret" class="form-input"/);
  assert.match(source, /<input type="password" id="google-client-secret"/,
    'and it is a password field, not plain text');
});

test('MB161-014: import refuses before connecting rather than failing obscurely', () => {
  const open = namedFunctionSource('ssOpenGoogleImport');
  // MB161-015: "couldn't read the status" and "not connected" are different
  // problems. Collapsing them told people to connect an account they had just
  // connected, which is the least useful thing the dialog could have said.
  assert.match(open, /if \(!status\) \{/, 'an unreadable status says so');
  assert.match(open, /status could not be read/);
  assert.match(open, /if \(!status\.connected\)/);
  assert.match(open, /!status\.configured/,
    'and a missing client ID is named separately from a missing account');
  assert.match(open, /Last attempt failed: \$\{_googleLastError\}/,
    'a failed connection carries its reason forward — the toast fired while the '
    + 'person was still in their browser');
});

test('MB161-014: an imported tab goes through the existing validated importer', () => {
  // ssImportBuildProject already bounds every cell, validates dimensions and —
  // since MB161-011 — refuses before writing anything if it will not fit.
  // Re-implementing any of that for Google would be a second place to get wrong.
  // namedFunctionSource stops at the next `function`, and the neighbours here
  // are `async function`, so bound the slice to this function's own body.
  const importPath = namedFunctionSource('_ssGoogleImport');
  assert.match(importPath, /await ssImportBuildProject\(name, read\.map\(/,
    'the Google path builds through the shared importer, not its own writer');
  assert.match(importPath, /sheetName: wanted\[i\]/,
    'sheetName is the field the importer reads — `name` silently lands the tab as "Sheet 1"');
  assert.doesNotMatch(importPath, /STORE\.(replace|set|mutate)/,
    'the Google path must not write to storage on its own');
});

test('MB161-018: every tab is read before any of them is written', () => {
  // Importing six tabs is six network round trips, and the fourth can fail. If
  // the project were built tab by tab, that would leave a half-imported project
  // linked to a spreadsheet it does not match — worse than importing nothing,
  // because it looks finished. So all reads complete first, then one build.
  const importPath = namedFunctionSource('_ssGoogleImport');
  const readLoop = importPath.slice(0, importPath.indexOf('ssImportBuildProject'));
  assert.match(readLoop, /for \(const title of wanted\)/, 'reads are a loop over the wanted tabs');
  assert.match(readLoop, /read\.push\(await _googleSheets\(\)\.read\(/,
    'and they are awaited one at a time — parallel grid reads trip the quota');
  assert.doesNotMatch(readLoop, /ssImportBuildProject|ssSave\(/,
    'nothing is written while reads are still outstanding');

  // And the sheet count is refused up front rather than discovered at save.
  assert.match(importPath, /wanted\.length > MAX_SPREADSHEET_SHEETS/);
});

test('MB161-018: imported fills, bold and merges survive the build', () => {
  const build = namedFunctionSource('ssImportBuildProject');
  // A blocked-out slot on a schedule is an empty cell with a black fill. The
  // first version of this kept cells only when `val !== ''`, which is exactly
  // the test that throws those away.
  assert.match(build, /if \(val !== '' \|\| bg \|\| tc \|\| bold \|\| checkbox\)/,
    'a cell worth keeping for its fill \u2014 or its checkbox \u2014 alone must be kept');
  assert.match(build, /_ssApplyImportedMerges\(cells, s\.merges, storedRows, storedCols\)/);
  // Optional, because CSV and .xlsx imports carry no formatting at all.
  assert.match(build, /Array\.isArray\(s\.formats\) \? s\.formats : null/);
});

test('MB161-016: the UI no longer promises read-only, because it is not true', () => {
  // This connection used to be read-only and Settings said so in bold. When the
  // scope widened to allow pushes, that sentence became a lie in the one place
  // somebody would go to check. A stale safety promise is worse than none: it
  // is the reason a person stops checking. So the old copy has to be gone, not
  // merely supplemented.
  assert.doesNotMatch(source, /spreadsheets\.readonly/,
    'Settings must not name the readonly scope it no longer requests');
  assert.doesNotMatch(source, /Google refuses the write/,
    'Google does not refuse our writes any more');
  assert.doesNotMatch(source, /Your Google sheet is never modified/,
    'the import dialog cannot claim that either');
  assert.doesNotMatch(source, /read-only access/,
    'and the connected status line must not say it');

  // What replaces it has to be specific about the two things a person actually
  // needs to know: when we write, and what happens to a cell somebody else
  // touched.
  assert.match(source, /only when you press a button/);
  assert.match(source, /nothing syncs on its own/);
  assert.match(source, /that cell is left alone and reported/);
  assert.match(source, /Nothing is written to Google until you press Push/,
    'the import dialog states it too, where the decision is being made');
});

test('MB161-016: the renderer still cannot reach Google directly', () => {
  // Two-way now, but the renderer composes a request and hands it to main; it
  // never speaks the Sheets API itself. That is what keeps the access token out
  // of the renderer and the CSP unwidened.
  const script = inlineScript(source);
  for (const forbidden of ['batchUpdate', 'valueInputOption', 'USER_ENTERED', 'batchClear']) {
    assert.equal(script.includes(forbidden), false,
      `the renderer must not contain ${forbidden}`);
  }
  for (const fn of ['ssPushToGoogle', 'ssPullFromGoogle']) {
    const body = namedFunctionSource(fn);
    assert.doesNotMatch(body, /\bfetch\s*\(/, `${fn} must not call Google itself`);
  }
});

test('MB161-016: a push sends only what changed since the last pull', () => {
  // The diff itself moved into _ssPendingPush when a project gained the ability
  // to mirror several tabs, but the rules it encodes did not change.
  const pending = namedFunctionSource('_ssPendingPush');
  assert.match(pending, /if \(cell\.value === was\) continue;/,
    'an unchanged cell is not pushed — otherwise every push rewrites the sheet');
  assert.match(pending, /expected: was/,
    'each cell carries what Google last held, which is what lets main detect a change');
  assert.match(pending, /for \(const \[key, was\] of Object\.entries\(checkpoint\)\)/,
    'a cell cleared in the app is pushed as a clear, not forgotten');

  const push = namedFunctionSource('ssPushToGoogle');
  assert.match(push, /confirm\(/, 'and the person is told how many cells before it happens');
  // MB161-018: the count in that prompt has to be the total across every tab.
  // Confirming six times, or confirming once against one tab's count and then
  // writing five more, are both ways of getting consent for the wrong thing.
  assert.match(push, /const total = work\.reduce\(/);
  assert.match(push, /Push \$\{total\} cell/);
  const beforeConfirm = push.slice(0, push.indexOf('confirm('));
  assert.doesNotMatch(beforeConfirm, /_googleSheets\(\)\.push/,
    'nothing is sent before the person answers');
});

test('MB161-018: a push says plainly that it does not carry formatting', () => {
  // Import and pull both bring colours and merges across, so it is reasonable to
  // assume a push sends them back. It does not — the values API has no way to.
  // Saying so in the prompt is the difference between a known limit and a
  // person believing their colour changes reached Google.
  const push = namedFunctionSource('ssPushToGoogle');
  assert.match(push, /Colours and merged cells are not pushed/);
});

test('MB161-016: a refused cell becomes a real conflict, not a warning', () => {
  const push = namedFunctionSource('ssPushToGoogle');
  assert.match(push, /result\.skipped\.length/);
  assert.match(push, /_ssData\._conflicts = conflicts/,
    'refused cells land in the same conflict list as a Mac-vs-Mac collision');
  assert.match(push, /remote: miss\.googleValue/, 'carrying what Google actually held');
  assert.match(push, /local: miss\.appValue/, 'and what the app wanted');
  assert.match(push, /base: miss\.expected/, 'and what they diverged from');
});

test('MB161-016: A1 and row,column notation round-trip', () => {
  const context = vm.createContext({ String, Number, RegExp });
  vm.runInContext(`
    ${namedFunctionSource('_ssCellKeyFromA1')}
    function ssColLabel(c) {
      let label = '', n = c;
      while (n >= 0) { label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26) - 1; }
      return label;
    }
    ${namedFunctionSource('_ssA1')}
    globalThis.api = { toKey: a => _ssCellKeyFromA1(a), toA1: (r, c) => _ssA1(r, c) };
  `, context);
  for (const [row, column, a1] of [[0,0,'A1'], [0,25,'Z1'], [0,26,'AA1'], [4,2,'C5'], [199,29,'AD200']]) {
    assert.equal(context.api.toA1(row, column), a1, `${row},${column} -> ${a1}`);
    assert.equal(context.api.toKey(a1), `${row},${column}`, `${a1} -> ${row},${column}`);
  }
  // Junk must not silently become A1 and write to the wrong cell.
  assert.equal(context.api.toKey('not-a-cell'), '0,0');
});

test('MB161-018: a pull now takes formatting from Google, and asks first', () => {
  // This reverses MB161-016 deliberately. Back then a pull preserved fills the
  // app had added, because Google sent no formatting at all and treating its
  // silence as "delete the colours" would have destroyed real work. Now the
  // read carries fills, bold and merges, so silence is no longer silence: a
  // cell with no fill in Google means no fill. Keeping the app's version would
  // make every pull drift further from the sheet it claims to mirror.
  //
  // It is still a real overwrite of anything restyled in the app, so unlike the
  // old pull it is confirmed rather than assumed.
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /confirm\(/, 'a destructive pull asks');
  assert.match(pull, /in the app since the last pull and not pushed will be lost/,
    'and says what it costs, in those words');
  const beforeConfirm = pull.slice(0, pull.indexOf('confirm('));
  assert.doesNotMatch(beforeConfirm, /target\.cells =/, 'and nothing is replaced before the answer');

  assert.match(pull, /const bg = _ssImportColor\(format\?\.bg\)/,
    'fills come from Google');
  assert.match(pull, /_ssApplyImportedMerges\(cells, remote\.merges, rowsThatFit, colsThatFit\)/,
    'and so do merges \u2014 bounded by what the sheet can actually hold');

  // A tab that grew in Google returns more rows than the sheet has. Writing
  // them anyway makes an out-of-range cell, which the validator refuses: the
  // pull would look fine and quarantine the project at the next save.
  assert.match(pull, /if \(r >= rowsThatFit\) return;/);
  assert.match(pull, /if \(c >= colsThatFit\) return;/);
  assert.match(pull, /target\.rows = rowsThatFit/, 'the sheet grows where it can');
  assert.match(pull, /checkpoint: _ssGoogleCheckpoint\(kept\)/,
    'and the checkpoint advances, or the next push would re-send everything');
});

test('MB161-018: pull and push walk every linked tab, not just the first sheet', () => {
  // Both used to read project.sheets[0] and link.title, which was correct while
  // a project could only ever mirror one tab. With all-tabs import that shape
  // silently syncs Monday and quietly ignores the other five.
  for (const name of ['ssPullFromGoogle', 'ssPushToGoogle']) {
    const fn = namedFunctionSource(name);
    assert.match(fn, /_ssLinkedSheets\(project\)/, `${name} works from the tab map`);
    assert.doesNotMatch(fn, /project\.sheets\[0\]/, `${name} must not assume one sheet`);
    assert.doesNotMatch(fn, /link\.title/, `${name} must not assume one tab name`);
  }
});

test('MB161-016: a linked project is tagged and offers pull and push', () => {
  assert.match(source, /class="ss-google-tag"/);
  assert.match(source, /p\.googleLink \?/, 'the tag only appears on linked projects');
  assert.match(source, /onclick="ssPullFromGoogle/);
  assert.match(source, /onclick="ssPushToGoogle/);
  assert.match(source, /event\.stopPropagation\(\)/,
    'the buttons must not also open the project');
});

test('MB161-018: the checkpoint is measured before the import, not after', () => {
  // A linked project stores a copy of every text value as Google last held it.
  // That roughly doubles the project, and it is attached AFTER the capacity
  // check in the caller — so leaving it out of the estimate lets an import pass
  // the check and then fail to save. The project would exist and be unwritable,
  // which is worse than a refusal.
  const importPath = namedFunctionSource('_ssGoogleImport');
  const build = importPath.indexOf('await ssImportBuildProject');
  const before = importPath.slice(0, build);
  assert.match(before, /const checkpoints = read\.map\(sheet => _ssGoogleCheckpoint/,
    'checkpoints are built before the import');
  assert.match(before, /const linkBytes = new TextEncoder\(\)/);
  assert.match(importPath, /\}\)\), linkBytes\);/, 'and passed into the capacity estimate');
  assert.match(namedFunctionSource('ssImportBuildProject'),
    /if \(typeof extraBytes === 'number' && extraBytes > 0\) incoming\.bytes \+= extraBytes/);
});

test('MB161-018: a tab taller than the grid ceiling is trimmed, not refused', () => {
  // Counting fills towards a tab's used extent made extents much bigger: a
  // schedule blocks out unavailable slots with black cells far below its last
  // piece of text. A tab that imported fine when only text counted can now
  // exceed the per-sheet ceiling. Refusing the whole import over rows nobody
  // reads is the wrong trade — the top of a schedule is the part that matters.
  const importPath = namedFunctionSource('_ssGoogleImport');
  assert.match(importPath, /MAX_SPREADSHEET_GRID_CELLS \/ Math\.max\(cols, 6\)/);
  assert.match(importPath, /sheet\.rows = sheet\.rows\.slice\(0, maxRows\)/);
  assert.match(importPath, /sheet\.formats = sheet\.formats\.slice\(0, maxRows\)/,
    'formats are trimmed with the values, or they would address the wrong rows');
  // Trimming silently would be the same bug wearing a different hat.
  assert.match(importPath, /trimmedTabs \+= 1/);
  assert.match(importPath, /taller than a sheet /, 'and it is said out loud');
});

test('MB161-018: a trimmed pull cannot delete the rows it trimmed', () => {
  // The worst bug found in review. A pull that drops rows beyond what the sheet
  // can hold, but records the untrimmed grid as the checkpoint, leaves those
  // cells "present at the last pull, absent now" — which is exactly the
  // condition _ssPendingPush turns into a push of an empty value. The app would
  // silently delete rows in Google that it had only declined to display.
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /const kept = \(remote\.rows \|\| \[\]\)\.slice\(0, rowsThatFit\)\.map\(row => row\.slice\(0, colsThatFit\)\)/);
  assert.match(pull, /checkpoint: _ssGoogleCheckpoint\(kept\)/,
    'the checkpoint describes what was kept, never what was sent');
  assert.doesNotMatch(pull, /_ssGoogleCheckpoint\(remote\.rows\)/,
    'the untrimmed grid must not be the checkpoint');
});

test('MB161-018: pull and push persist each tab before starting the next', () => {
  // Six tabs is six round trips and the fourth can fail. Saving once at the end
  // means the first three are already written in Google (push) or replaced in
  // memory (pull) while their checkpoints are still the old ones — so the next
  // push re-sends cells Google already has, Google refuses them, and the app
  // reports its own writes as somebody else's edits.
  for (const name of ['ssPullFromGoogle', 'ssPushToGoogle']) {
    const fn = namedFunctionSource(name);
    const loopStart = fn.indexOf('for (const');
    const loopEnd = fn.lastIndexOf('    }');
    const loop = fn.slice(loopStart, loopEnd);
    assert.match(loop, /project\.googleLink = \{ \.\.\.link,/, `${name} updates the link inside the loop`);
    assert.match(loop, /await ssSave\(\)/, `${name} saves inside the loop`);
  }
});

test('MB161-018: the import trim measures against the stored width', () => {
  // The importer pads a narrow sheet out to six columns. Computing the row
  // ceiling from the read width let a one-column tab keep 10,000 rows, which
  // became 60,000 stored cells and failed the check the trim exists to satisfy.
  const importPath = namedFunctionSource('_ssGoogleImport');
  assert.match(importPath, /Math\.max\(cols, 6\)/);
  assert.doesNotMatch(importPath, /Math\.max\(cols, 1\)/);
});

// ── MB161-019: reading the grid ─────────────────────────────────────────────

test('MB161-019: a pinch zooms the grid and nothing else', () => {
  const bind = namedFunctionSource('_ssBindZoom');
  // A trackpad pinch arrives as a wheel event with ctrlKey set. That is how the
  // gesture is delivered, not a key anybody is holding, so reading it as a
  // modifier combination would be wrong.
  assert.match(bind, /if \(!e\.ctrlKey\) return;/, 'an ordinary two-finger scroll is left alone');
  assert.match(bind, /e\.preventDefault\(\)/,
    'taken before Chromium reads it as page zoom, which would scale the sidebar too');
  assert.match(bind, /\{ passive: false \}/,
    'preventDefault on wheel does nothing without this');
  // Bound on first render, not at boot: the grid is not in the DOM until
  // Spreadsheets is opened, so a boot-time listener has nothing to attach to.
  assert.match(bind, /wrap\._ssZoomBound/, 'and bound exactly once');
  assert.match(namedFunctionSource('ssRenderGrid'), /_ssBindZoom\(\)/);
});

test('MB161-019: zoom is clamped, and is not workbook data', () => {
  const context = vm.createContext({ Number, Math, JSON });
  vm.runInContext(`
    var SS_ZOOM_MIN = 0.5, SS_ZOOM_MAX = 2;
    ${namedFunctionSource('_ssClampZoom')}
    globalThis.clamp = value => _ssClampZoom(value);
  `, context);
  assert.equal(context.clamp(1), 1);
  assert.equal(context.clamp(5), 2, 'clamped up top');
  assert.equal(context.clamp(0.01), 0.5, 'and at the bottom');
  // A stored value that has been corrupted must not make the grid disappear.
  for (const junk of [NaN, Infinity, -Infinity, 'huge', null, undefined]) {
    assert.equal(context.clamp(junk), 1, `${String(junk)} falls back to 100%`);
  }

  // Zoom belongs to whoever is at this Mac. Putting it in the workbook would
  // push one person's zoom onto the other machine as a synced change.
  const set = namedFunctionSource('ssSetZoom');
  assert.match(set, /localStorage\.setItem\(SS_ZOOM_KEY/);
  assert.doesNotMatch(set, /STORE\.|ssSave\(/, 'view state is never synced');
});

test('MB161-019: an open cell keeps the fill it is being edited in', () => {
  // The editor forced background:#fff, so opening a black blocked-out cell
  // turned it white while you typed — the block appeared to vanish, and on a
  // cell carrying white text you were typing white on white.
  const editing = source.slice(source.indexOf('#ss-grid td.ss-editing .ss-cell-input'));
  const rule = editing.slice(0, editing.indexOf('}'));
  assert.doesNotMatch(rule, /background/,
    'the editor must not override the cell background');
  assert.doesNotMatch(rule, /(^|[^-])color:/,
    'nor its text colour');
  assert.match(rule, /outline:2px solid #1a73e8/,
    'the blue outline is what says "open", which the white was standing in for');

  // Those two only inherit because the base rule says so, so that has to hold.
  const base = source.slice(source.indexOf('    .ss-cell-input {'));
  assert.match(base.slice(0, base.indexOf('}')), /background:inherit;color:inherit/);
});

test('MB161-019: a merged cell wraps but never grows its row', () => {
  // height:auto here was written when a merge was a rare, deliberate act. An
  // imported Google schedule is built almost entirely out of rowspan-2 merges,
  // so the exception became the rule: one long note set the height of its whole
  // row and 26px rows became 90px ones.
  const start = source.indexOf('#ss-grid td[rowspan]:not([rowspan="1"]),');
  assert.notEqual(start, -1);
  const tdRule = source.slice(start, source.indexOf('}', start));
  assert.doesNotMatch(tdRule, /height:auto/,
    'a merged cell takes its room from its rowspan, never from its text');
  assert.match(tdRule, /height:26px/, 'the same row height as every other cell');

  const innerStart = source.indexOf('#ss-grid td[rowspan]:not([rowspan="1"]) .ss-cell-inner,');
  assert.notEqual(innerStart, -1);
  const innerRule = source.slice(innerStart, source.indexOf('}', innerStart));
  assert.match(innerRule, /-webkit-line-clamp:2/, 'two lines, then it clips');
  assert.match(innerRule, /max-height:36px/, 'and cannot exceed the two lines it clamps to');
  assert.match(innerRule, /overflow:hidden/);
});

test('MB161-019: an ordinary cell is still one clipped line', () => {
  // The formula bar is what shows the whole value, so no cell needs to.
  const start = source.indexOf('    .ss-cell-inner {');
  const rule = source.slice(start, source.indexOf('}', start));
  assert.match(rule, /white-space:nowrap/);
  assert.match(rule, /overflow:hidden/);
  assert.match(rule, /text-overflow:ellipsis/);
  assert.match(rule, /height:26px/);
});
