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
  // MB161-045: "every signed-in profile" is COMMUNICATION_ROLES. Spelling the
  // roles out here is what let a later role be left behind without failing.
  assert.match(
    mainSource,
    /_secureHandle\('firebase-runtime-config'[\s\S]*?_requireAppRole\(COMMUNICATION_ROLES\)/
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

test('MB161-034: the AI pause is one shared studio estimate, and says so', () => {
  assert.match(script, /AI_TEAM_MONTHLY_CAP_USD = 20\.00/);
  assert.match(script, /'claude-opus-4-5':\s*\{ input:\s*5\.00, output:\s*25\.00 \}/);
  assert.match(script, /'claude-haiku-4-5-20251001':\s*\{ input:\s*1\.00, output:\s*5\.00 \}/);
  // The wording matters as much as the number: told it was "this Mac's" pause,
  // somebody would reasonably assume the other Mac had its own to spend.
  assert.match(source, /The studio's estimated AI-use pause/);
  assert.doesNotMatch(source, /This Mac's estimated AI-use pause/);
  assert.doesNotMatch(source, /This Mac estimate/);
  assert.match(source, /Anthropic billing may differ/,
    'it is still an estimate, and still not an account-wide limit');
  assert.doesNotMatch(source, /AI monthly budget/);
  // Shared means synced. A local key would leave the cap per-Mac in fact while
  // claiming otherwise in the copy.
  assert.match(script, /'ai_spend',/);
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
  // MB161-029: the file importer and its worker are gone. The utility process
  // remains for PDF text extraction, which is a different feature.
  assert.match(mainSource, /utilityProcess\.fork\(workerPath/);
  assert.ok(!mainSource.includes('spreadsheet-worker.js'));
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
      isOperationsManager: () => (profiles.find(p => p.name === current) || {}).role === 'Operations Manager',
      currentUser: () => current,
    };
    vm.runInNewContext(`${namedFunctionSource('getAssignableStaff')}; this.result = getAssignableStaff();`, sandbox);
    return JSON.parse(JSON.stringify(sandbox.result));
  };
  // MB161-038: everybody can give themselves a task, so self is always present.
  // A to-do for yourself is not an exercise of authority over anybody, and
  // modelling delegation purely as authority left Front Desk with an empty
  // dropdown — and the Owner unable to write herself a task, since she was
  // excluded by her own "everyone except Owners" rule.
  assert.deepEqual(evaluateFor('Elizabeth Chaves'),
    ['Elizabeth Chaves', 'Carrie Gass', 'Ana Chaves', "Quinn O'Neil"]);
  assert.deepEqual(evaluateFor('Carrie Gass'),
    ['Carrie Gass', 'Ana Chaves', "Quinn O'Neil"]);
  // MB161-048: front desk assigns nothing at all. My Tasks is where work is
  // HANDED to somebody; a front-desk profile writing its own entries there
  // turns a delegation list into a second private to-do list nobody watches.
  // Team To-Do is the shared list and stays open to everyone.
  assert.deepEqual(evaluateFor('Ana Chaves'), []);
  assert.deepEqual(evaluateFor("Quinn O'Neil"), []);

  // MB161-031: an Operations Manager delegates to everyone except the Owner.
  profiles.push({ name: 'Dana Reid', role: 'Operations Manager' });
  assert.deepEqual(evaluateFor('Dana Reid'),
    ['Carrie Gass', 'Ana Chaves', "Quinn O'Neil", 'Dana Reid']);
  assert.ok(!evaluateFor('Dana Reid').includes('Elizabeth Chaves'),
    'and never the Owner');

  // Nobody appears twice, whichever branch put them there.
  for (const who of ['Elizabeth Chaves', 'Carrie Gass', 'Dana Reid']) {
    const list = evaluateFor(who);
    assert.equal(new Set(list).size, list.length, `${who} is listed once`);
    assert.ok(list.includes(who), `${who} can assign to themselves`);
  }
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
  // MB1188-032: a cell that is only a dropdown is worth keeping too.
  assert.match(build, /if \(val !== '' \|\| bg \|\| tc \|\| bold \|\| checkbox \|\| listKey !== undefined\)/,
    'a cell worth keeping for its fill \u2014 or its checkbox \u2014 alone must be kept');
  assert.match(build, /_ssApplyImportedMerges\(cells, s\.merges, storedRows, storedCols\)/);
  // Optional, because CSV and .xlsx imports carry no formatting at all.
  assert.match(build, /Array\.isArray\(s\.formats\) \? s\.formats : null/);
});

test('MB161-021: the renderer cannot reach Google, and cannot write to it', () => {
  // The renderer composes a request and hands it to main; it never speaks the
  // Sheets API itself. That is what keeps the access token out of the renderer
  // and the CSP unwidened.
  const script = inlineScript(source);
  for (const forbidden of ['batchUpdate', 'valueInputOption', 'USER_ENTERED', 'batchClear',
                           'ssPushToGoogle', '_ssPendingPush', 'google-sheet-push']) {
    assert.equal(script.includes(forbidden), false,
      `the renderer must not contain ${forbidden}`);
  }
  assert.doesNotMatch(namedFunctionSource('ssPullFromGoogle'), /\bfetch\s*\(/,
    'the sync must not call Google itself');
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
  assert.match(importPath, /\}\)\), linkBytes, /, 'and passed into the capacity estimate');
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
  assert.match(pull, /checkpoint: _ssGoogleCheckpoint\(kept, keptFormats\)/,
    'the checkpoint describes what was kept, never what was sent');
  assert.match(pull, /const keptFormats = \(remote\.formats \|\| \[\]\)\.slice\(0, rowsThatFit\)/,
    'and MB1188-011: its formatting is trimmed to the same extent');
  assert.doesNotMatch(pull, /_ssGoogleCheckpoint\(remote\.rows/,
    'the untrimmed grid must not be the checkpoint');
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

test('MB161-024: a read asks for the tab that exists, not the largest allowed', () => {
  // Every read requested 500x100 regardless, so a 26-column schedule came back
  // with 74 columns of nothing — and since MB161-022 each cell carries a fill,
  // a text colour and both of Google's two ways of expressing each, "nothing"
  // is not cheap. Roughly three quarters of the payload, the parse and the
  // per-cell loop went on cells that do not exist.
  const window = namedFunctionSource('_ssTabWindow');
  assert.match(window, /_ssGoogleLookup\?\.tabs \|\| \[\]/, 'the real grid comes from describe');
  assert.match(window, /Math\.min\([\s\S]*GOOGLE_IMPORT_ROWS\)/, 'still bounded by the ceiling');
  assert.match(window, /Math\.min\([\s\S]*GOOGLE_IMPORT_COLUMNS\)/);

  const importPath = namedFunctionSource('_ssGoogleImport');
  assert.match(importPath, /const window = _ssTabWindow\(title\)/);
  assert.match(importPath, /rows: window\.rows/);
  assert.match(importPath, /columns: window\.columns/);
  // And the stored link records what was actually needed, so later syncs are
  // just as cheap rather than reverting to the maximum.
  assert.match(importPath, /rows: Math\.max\(\.\.\.windows\.map\(w => w\.rows\)\)/);
});

test('MB161-024: the phase is named, so a slow step is not mistaken for a stuck one', () => {
  // Reported as "freezing on the last sheet". It was not the last sheet: the
  // label said "Reading Saturday… (6 of 6)" and then never changed, while
  // trimming, checkpointing, building six sheets, normalising and encrypting
  // all ran synchronously behind it. The read had already finished.
  const importPath = namedFunctionSource('_ssGoogleImport');
  assert.match(importPath, /_ssGoogleStatus\(el, wanted\.length > 1/, 'reads are announced');
  assert.match(importPath, /Building \$\{wanted\.length\} sheets…/, 'and so is the build');
  assert.match(importPath, /_ssGoogleStatus\(el, 'Saving…'\)/, 'and the save');

  const status = namedFunctionSource('_ssGoogleStatus');
  assert.match(status, /await _ssYield\(\)/,
    'setting text is useless without giving the thread back to paint it');
  assert.match(namedFunctionSource('_ssYield'), /setTimeout\(resolve, 0\)/);
});

test('MB161-024: an import that cannot fit is refused before it is built', () => {
  // The reads already report filled-cell counts, so a workbook-capacity
  // refusal costs microseconds here instead of arriving after six sheets have
  // been built, stringified and measured.
  const importPath = namedFunctionSource('_ssGoogleImport');
  const build = importPath.indexOf('await ssImportBuildProject');
  const early = importPath.indexOf('_ssCapacityRefusal');
  assert.ok(early > -1 && early < build, 'the cheap check comes first');
  assert.match(importPath, /read\.reduce\(\(sum, sheet\) => sum \+ \(sheet\.filledCells \|\| 0\), 0\)/);
});

test('MB161-025: a deletion is flushed to disk, not fired and forgotten', () => {
  // Diagnosed from a screenshot of the "Some recent changes may still be
  // waiting to save" prompt. A project's document is deliberately never
  // removed — so a delete cannot destroy content another Mac has not synced
  // yet — which makes the index tombstone the ONLY record that the deletion
  // happened. Deleting called ssSave() and moved on, so if the app was closed
  // with that save still pending and somebody chose "Quit Without Saving", the
  // tombstone was lost, the document was still there, and the project came
  // back on the next launch.
  for (const fn of ['ssDeleteProject', 'ssDeleteSheet']) {
    const body = namedFunctionSource(fn);
    assert.match(body, /_ssPersistDeletion\(/, `${fn} waits for the write`);
    assert.doesNotMatch(body, /(?<!_)\bssSave\(\);/,
      `${fn} must not fire a save and move on`);
  }

  const persist = namedFunctionSource('_ssPersistDeletion');
  assert.match(persist, /await _flushSpreadsheetSave\(\)/,
    'the index tombstone is pushed all the way to the store');
  // And if it cannot be written, that is said rather than left to be found out
  // when the project reappears.
  assert.match(persist, /could not be saved yet/);
  assert.match(persist, /may come back when the app restarts/,
    'named precisely, because that is the symptom somebody would otherwise report');
});

test('MB161-025: both deletions are async, or the await does nothing', () => {
  // An `await` inside a function nobody awaits still returns control to the
  // caller immediately. These are called from onclick handlers, so what matters
  // is that the flush is started and completed before the function resolves.
  const script = inlineScript(source);
  assert.match(script, /async function ssDeleteProject\(/);
  assert.match(script, /async function ssDeleteSheet\(/);
  assert.match(script, /async function _ssPersistDeletion\(/);
});

test('MB161-026: the Google link is written by the import, not by a second save', () => {
  // The dialog sat on "Saving…" because the import saved twice: once to create
  // the project, then again after mutating it to attach the link. With split
  // storage that is every project document encrypted and synchronised a second
  // time — fourteen writes for a seven-tab import — to store one small piece of
  // metadata.
  const build = namedFunctionSource('ssImportBuildProject');
  assert.match(build, /ssImportBuildProject\(name, sheets, extraBytes, linkFor\)/);
  assert.match(build, /const link = linkFor\(builtSheets\)/,
    'the link is built from the sheets that were actually stored');
  assert.match(build, /if \(link\) record\.googleLink = link/);

  const importPath = namedFunctionSource('_ssGoogleImport');
  assert.match(importPath, /\}\)\), linkBytes, \(builtSheets\) => \{/,
    'the Google importer supplies it rather than attaching it afterwards');
  // The second save is gone. This is the assertion that would catch it coming
  // back, since the symptom is only visible on a slow machine.
  const afterBuild = importPath.slice(importPath.indexOf("if (created && typeof created === 'object')"));
  assert.doesNotMatch(afterBuild, /await ssSave\(\)/,
    'nothing saves again once the import has committed');
  assert.doesNotMatch(afterBuild, /created\.googleLink =/,
    'and the created project is not mutated after the fact');
});

test('MB161-026: an import is one commit, so it cannot half-exist', () => {
  // Between the two saves the project existed with no link at all. Quitting in
  // that window left an imported project that would never sync with the sheet
  // it came from, and nothing in the UI would have explained why.
  const build = namedFunctionSource('ssImportBuildProject');
  const push = build.indexOf('next.projects.push(record)');
  const store = build.indexOf("STORE.replace('spreadsheets'");
  assert.ok(push > -1 && store > push,
    'the link is part of the record before the single write that stores it');
});

test('MB161-027: deleting records the id before it removes the project', () => {
  // Order matters. Recording after the splice would be recording it from the
  // same state that already cannot see it.
  const del = namedFunctionSource('ssDeleteProject');
  const record = del.indexOf('_ssDeletedProjectIds.add');
  const splice = del.indexOf('projects.splice');
  assert.ok(record > -1 && splice > -1 && record < splice);
});

test('MB161-027: a pending deletion is forgotten only once it is buried', () => {
  // Clearing the set on attempt rather than on success is how a failed index
  // write turns into a project quietly returning.
  const commit = namedFunctionSource('_ssCommitSplitWorkbook');
  assert.match(commit, /_ssIndexAfterEdit\(currentIndex, dirtyBase, dirty, at, \[\.\.\._ssDeletedProjectIds\]\)/);
  const clear = commit.indexOf('_ssDeletedProjectIds.delete');
  const write = commit.indexOf("written.push('spreadsheets')");
  assert.ok(clear > -1 && write > -1 && clear > write, 'cleared after the write, not before');
  assert.match(commit, /if \(record\?\._deleted\) _ssDeletedProjectIds\.delete/,
    'and only for ids the written index actually tombstones');
});

test('MB161-028: zoom keeps the point under the pointer', () => {
  // Scaling alone anchors at the top-left, so pinching to look closely at
  // Thursday afternoon threw Thursday afternoon off screen.
  const bind = namedFunctionSource('_ssBindZoom');
  assert.match(bind, /const contentX = \(wrap\.scrollLeft \+ pointerX\) \/ before/,
    'the cursor is converted to unscaled content coordinates first');
  assert.match(bind, /wrap\.scrollLeft = contentX \* _ssZoom - pointerX/,
    'and the scroll is restored so that point lands back under the cursor');
  assert.match(bind, /if \(_ssZoom === before\) return;/,
    'clamped at a limit nothing moved, so nothing should be scrolled');
  // Measured from the element, not the window: the grid is not at the origin.
  assert.match(bind, /wrap\.getBoundingClientRect\(\)/);
});

test('MB161-028: imported columns use Google’s widths, not a guess', () => {
  const build = namedFunctionSource('ssImportBuildProject');
  assert.match(build, /const givenWidths = Array\.isArray\(s\.colWidths\) \? s\.colWidths : null/);
  assert.match(build, /if \(Number\.isFinite\(given\) && given > 0\)/,
    'a real width wins');
  // A CSV has no widths at all, so the estimate has to survive as the fallback.
  assert.match(build, /maxLen \* 8/);
  assert.match(namedFunctionSource('_ssGoogleImport'), /colWidths: sheet\.columnWidths/);
});

test('MB161-030: the mirroring flag is always cleared, on every path', () => {
  // A flag that suppresses attribution is exactly the kind that must not stick:
  // left set, every subsequent edit by a real person would be recorded as
  // nobody's, which is silent and would not be noticed for a long time.
  const build = namedFunctionSource('ssImportBuildProject');
  assert.match(build, /\} finally \{\s*_ssMirroringFromGoogle = false;/,
    'cleared in a finally around the write');
  assert.match(build, /catch \(error\) \{\s*_ssMirroringFromGoogle = false;/,
    'and on the failure path before the write');

  // MB161-040: the sync save sets and clears the flag with nothing awaited in
  // between. Holding it across an await would suppress the attribution of
  // anything somebody typed while a background sync happened to be in flight.
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /_ssMirroringFromGoogle = true;\s*\n\s*const saving = ssSave\(\);\s*\n\s*_ssMirroringFromGoogle = false;\s*\n\s*await saving;/,
    'the flag is cleared before the await, not after it');

  // It has to be held across the write, not just the build: the attribution is
  // stamped by the operations derived during the commit.
  const set = build.indexOf('_ssMirroringFromGoogle = true');
  const replace = build.indexOf("STORE.replace('spreadsheets'");
  assert.ok(set > -1 && replace > set, 'set before the write that carries the cells');
});

test('MB161-032: Staff Workload is refused by the router, not just hidden', () => {
  // Hiding a nav item is presentation. The check that decides has to be in the
  // router, or the page is reachable by any other route.
  const access = namedFunctionSource('canAccessPage');
  assert.match(access, /if \(page === 'workload'\) return canManageStudio\(\);/);
  assert.match(namedFunctionSource('navigate'), /Staff Workload is available to the owner/);
  assert.match(source, /id="nav-workload"[^>]*style="display:none"/,
    'and it starts hidden rather than flashing for everyone on load');
});

test('MB161-032: the workload review is framed as workload, not as a score', () => {
  // The only thing this can see is what somebody wrote down and ticked off. A
  // quiet shift handled well produces almost nothing. Presenting that as a
  // productivity ranking would measure diligence at note-taking and call it
  // work — and it would be read as a verdict on a person.
  const run = namedFunctionSource('ssRunStaffWorkload');
  assert.match(run, /Do NOT rank people, score them/);
  assert.match(run, /too thin to support any conclusion about a person/);
  assert.match(run, /never compare across \s*'?\s*\+?\s*'?roles as though it were the same job/);
  // And the caveat is in front of the person reading it, not only in the prompt.
  assert.match(source, /Not a performance score<\/b>, and not sound grounds/);
});

test('MB161-032: completions record who, and unknown ones stay unknown', () => {
  // `done` was a bare boolean, so there was nothing to analyse. Attribution
  // starts now, which means everything finished earlier has no name — and
  // guessing at those would be worse than counting them separately.
  const mark = namedFunctionSource('_markDone');
  assert.match(mark, /doneBy: currentUser\(\) \|\| 'Unknown'/);
  assert.match(mark, /doneAt: new Date\(\)\.toISOString\(\)/);
  assert.match(mark, /const \{ doneBy, doneAt, \.\.\.rest \} = item/,
    'un-ticking clears the name, so it cannot linger on a task that is open again');

  // The counting moved into _ssWorkloadStats when the charts arrived; the rule
  // did not change.
  assert.match(namedFunctionSource('_ssWorkloadStats'),
    /if \(!item\.doneBy\) \{ unattributed \+= 1; return; \}/);
  assert.match(namedFunctionSource('ssRunStaffWorkload'), /have no name recorded/,
    'and the count is shown rather than hidden');
});

test('MB161-033: every AI caller respects the monthly pause and records its spend', () => {
  // The pause is only a pause if nothing can go around it. Staff Workload is
  // the most expensive single call in the app — Sonnet, with up to 60,000
  // characters of log behind it — and it shipped checking neither.
  for (const fn of ['ssRunStaffWorkload']) {
    const body = namedFunctionSource(fn);
    assert.match(body, /if \(aiAtSpendLimit\(\)\)/, `${fn} checks the pause first`);
    assert.match(body, /addAiSpend\(/, `${fn} records what it spent`);
    const guard = body.indexOf('aiAtSpendLimit()');
    const send = body.indexOf('_sendAiMessage(');
    assert.ok(guard > -1 && send > guard, `${fn} checks BEFORE it spends`);
  }
  // And the estimate is shown, not just accumulated silently.
  assert.match(namedFunctionSource('ssRunStaffWorkload'), /AI estimate: \$/);
});

test('MB161-035: every page container is balanced and contains only itself', () => {
  // The Daily Log form appeared on Settings, Spreadsheets and Staff Workload.
  // Cause: an orphaned </div> left behind when I removed a modal by slicing on
  // string indices, which closed `page-log` 376 characters in. Everything after
  // it sat outside any page, so it rendered on all of them.
  //
  // The script parsed fine and every test passed, because nothing here was
  // checking the HTML. This is that check: each page must close, and it must
  // not swallow the next page.
  const pages = [...source.matchAll(/<div id="(page-[a-z]+)" class="page">/g)]
    .map(match => ({ id: match[1], at: match.index + match[0].length }));
  assert.ok(pages.length >= 8, 'the page containers were found');

  for (const page of pages) {
    let depth = 1;
    let end = -1;
    for (const token of source.slice(page.at).matchAll(/<div\b|<\/div>/g)) {
      depth += token[0].startsWith('<div') ? 1 : -1;
      if (depth === 0) { end = page.at + token.index + token[0].length; break; }
    }
    assert.notEqual(end, -1, `${page.id} is never closed`);
    const body = source.slice(page.at, end);
    for (const other of pages) {
      if (other.id === page.id) continue;
      assert.ok(!body.includes(`<div id="${other.id}" class="page">`),
        `${page.id} swallows ${other.id} — it is missing a closing tag`);
    }
  }
});

test('MB161-037: the renderer and main agree on which roles exist', () => {
  // Adding Operations Manager to main.js left two hand-written lists in the
  // renderer behind. The dropdown simply never offered it. The validator was
  // worse: it REJECTS a profile carrying an unlisted role, so the whole profile
  // list would have been thrown out the moment anybody was given the new role.
  assert.match(script, /const ASSIGNABLE_ROLES = Object\.freeze\(\['Operations Manager', 'Operations & Events', 'Front Desk'\]\)/);
  assert.match(script, /const ALL_PROFILE_ROLES = Object\.freeze\(\['Owner', \.\.\.ASSIGNABLE_ROLES\]\)/);

  // Both consumers use the shared list rather than repeating it.
  assert.match(script, /\$\{ASSIGNABLE_ROLES\.map\(r =>/, 'the Manage Users dropdown');
  assert.match(script, /!ALL_PROFILE_ROLES\.includes\(role\)/, 'the profile-list validator');
  assert.ok(!/\['Owner', 'Operations & Events', 'Front Desk'\]/.test(script),
    'no hand-written copy of the role list survives');
  assert.ok(!/\['Operations & Events', 'Front Desk'\]/.test(script));

  // And the renderer's list matches what main will actually accept.
  const mainList = mainSource.match(/ASSIGNABLE_PROFILE_ROLES = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(mainList, 'main declares the assignable roles');
  const rendererList = script.match(/ASSIGNABLE_ROLES = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.equal(rendererList[1].trim(), mainList[1].trim(),
    'a role the renderer offers but main refuses is a dropdown that throws');
});

test('MB161-037: a synced key must declare its shape, or every write is refused', () => {
  // `ai_spend` is { month, devices } — an object. _expectedSyncType defaults to
  // 'array', so adding the key without listing it here made every write throw
  // "ai_spend expected array data", including on the login screen.
  //
  // MB1188-069 then did exactly the same thing with `staff_passcodes`, and this
  // test did not catch it: it only ever asserted `ai_spend`. So it now walks the
  // real key list against an explicit table. A new synced key that is not in the
  // table fails here, which forces the shape to be a decision rather than a
  // default — the whole point of the original finding.
  const SHAPES = {
    logs: 'array', staff_notes: 'array', todo_items: 'array',
    assigned_tasks: 'array', staff: 'array', deleted_emails: 'array',
    sent_emails: 'array', ms_sent_emails: 'array', ms_sent_conv_ids: 'array',
    custom_staff: 'array', room_excluded: 'array', step_up_receipts: 'array',
    flagged_emails: 'array', comm_analyzed_ids: 'array', comm_handled_ids: 'array',
    rc_read_convs: 'array', policies: 'array', staff_dir_overrides: 'array',
    removed_staff_dir: 'array', staff_directory: 'array',
    room_overrides: 'object', room_by_instructor: 'object',
    room_time_rules: 'object', spreadsheets: 'object', ai_spend: 'object',
    staff_passcodes: 'object',
  };

  const expected = namedFunctionSource('_expectedSyncType');
  const keys = script.match(/const SYNC_BASE_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .match(/'([a-z_]+)'/g).map(k => k.replace(/'/g, ''));
  const objectKeys = expected.match(/\[([^\]]*)\]\.includes\(key\)/)[1]
    .match(/'([a-z_]+)'/g).map(k => k.replace(/'/g, ''));

  const undeclared = keys.filter(key => !(key in SHAPES));
  assert.deepEqual(undeclared, [],
    'a new synced key must declare its shape here and in _expectedSyncType');

  for (const key of keys) {
    const isObject = objectKeys.includes(key);
    assert.equal(isObject ? 'object' : 'array', SHAPES[key],
      `${key} is declared ${SHAPES[key]} but _expectedSyncType says ` +
      `${isObject ? 'object' : 'array'} — every write of it would be refused`);
  }

  // And the two that have actually bitten, named outright.
  assert.ok(objectKeys.includes('ai_spend'), 'ai_spend is synced, so its shape has to be declared');
  assert.ok(objectKeys.includes('staff_passcodes'), 'and so is staff_passcodes');
});

test('MB161-038: a task you gave yourself can be ticked off and removed', () => {
  // Otherwise letting people self-assign is half a fix — Front Desk could write
  // a to-do and then have no way to close it.
  const toggle = namedFunctionSource('toggleAssignedTask');
  assert.match(toggle, /task\.assignee !== user/,
    'the assignee may complete their own task');
  const remove = namedFunctionSource('deleteAssignedTask');
  assert.match(remove, /task\.assignedBy !== currentUser\(\)/,
    'and whoever created it may delete it — which for a self-assigned task is the same person');
  // And they can see it: a self-assigned task matches on both counts.
  const render = namedFunctionSource('renderMyTasks');
  assert.match(render, /t\.assignee === user \|\|\s*\n?\s*t\.assignedBy === user/);
});

test('MB161-040: the merge base is a workbook, never the index', () => {
  // Under split storage the durable 'spreadsheets' snapshot is the INDEX — a
  // list of project ids. Two places treated it as a workbook.
  //
  // As the merge base it made _ssProjectAsDoc return null, so
  // _mergeSpreadsheetEdits short-circuited and no operations were derived.
  // Operations carry attribution, which is why ordinary edits stopped showing
  // in the activity sidebar while an old import's stamps stayed visible.
  const stage = namedFunctionSource('_stageDirtySpreadsheetSave');
  assert.match(stage, /_ssDirtyBase = _ssDurableWorkbook\(\) \|\| _cloneJson\(_ssData\)/);
  assert.doesNotMatch(stage, /_durableStoreSnapshots\.get\('spreadsheets'\)/,
    'the raw snapshot is not a workbook and must not be used as one');

  // MB1188-053: the other half of this — the recovery path after a failed
  // write, where the raw index would have replaced the whole workbook — is gone
  // entirely. A failed save no longer replaces _ssData with anything, because
  // replacing it was itself the defect: it discarded the edit. The lesson still
  // holds for _ssDurableWorkbook's remaining callers, which is what the helper
  // assertions below cover.
  const stagePath = namedFunctionSource('_beginSpreadsheetSaveStage');
  assert.doesNotMatch(stagePath, /_ssData = durable;/,
    'a failed save must not overwrite the live workbook with the durable one');

  const helper = namedFunctionSource('_ssDurableWorkbook');
  // MB1188-072: still assembles rather than reading the raw snapshot — but in
  // DURABLE mode, so every value it assembles comes from _durableStoreSnapshots
  // instead of _decCache, which the live workbook aliases.
  assert.match(helper, /_ssReadStoredWorkbook\(true\)/, 'it assembles rather than reading a snapshot');
  assert.match(helper, /catch \(_\) \{\s*\n?\s*return null;/,
    'and a workbook that will not assemble is "no base", not an exception');
});

test('MB161-041: three charts, each comparable only down its own column', () => {
  // The stacked bar was unreadable: a segment's width depended on the row's
  // total, so the same number of log entries drew a different length on every
  // row, and somebody with only log entries got a solid block that looked like
  // one unexplained quantity. The weekly chart below then reused that colour
  // for something else entirely.
  const chart = namedFunctionSource('_ssWorkloadChartHtml');
  assert.match(chart, /const measures = \[/);
  assert.match(chart, /const peak = Math\.max\(\.\.\.rows\.map\(row => row\.counts\[measure\.key\]\), 0\)/,
    'each chart is scaled to its own busiest value');
  assert.match(chart, /compare down a column, never across/);
  // The confusing weekly chart is gone rather than relabelled.
  assert.ok(!script.includes('wl-weeks') && !script.includes('Everything recorded, by week'));
  // Every profile is drawn, including the ones at zero.
  assert.doesNotMatch(chart, /\.filter\(row => row\.total > 0\)/);
});

test('MB161-041: the AI is told to read completed versus pending', () => {
  const run = namedFunctionSource('ssRunStaffWorkload');
  assert.match(run, /MANY ENTRIES ARE STRUCTURED/);
  assert.match(run, /must NOT be described as work they completed/);
  assert.match(run, /keeps reappearing as pending across entries/,
    'a repeatedly deferred item is the signal worth surfacing');
});

test('MB161-046: the figures refresh themselves, the AI summary does not', () => {
  // The counts are arithmetic over data already in memory — no network, no
  // model, no cost — so nobody should have to press a button to find out
  // whether they are looking at something stale. The written summary is the
  // opposite: it spends against a shared monthly budget, so it stays deliberate.
  assert.match(script, /function ssRenderWorkloadCharts\(\)/);
  const opened = namedFunctionSource('ssWorkloadPageOpened');
  assert.match(opened, /ssRenderWorkloadCharts\(\)/, 'current on arrival');
  assert.match(opened, /setInterval/);
  assert.match(opened, /page-workload'\)\?\.classList\.contains\('active'\)/,
    'and only while somebody is actually looking at it');

  // The timer is stopped on leaving, or it keeps recomputing forever.
  assert.match(namedFunctionSource('navigate'), /ssWorkloadPageClosed\(\)/);
  assert.match(namedFunctionSource('ssWorkloadPageClosed'), /clearInterval/);

  // A change to any of the four sources redraws them, whichever Mac made it.
  assert.match(script, /key === 'logs' \|\| key === 'todo_items' \|\| key === 'assigned_tasks' \|\|\s*\n?\s*key === 'spreadsheets' \|\| _ssIsProjectSyncKey\(key\)/);
  assert.match(script, /try \{ ssWorkloadDataChanged\(\); \} catch \(_\) \{\}/);

  // And the expensive half is NOT on the timer. namedFunctionSource stops at
  // the next `\nfunction `, and the neighbour here is `async function`, so the
  // slice overruns — bound it to the function's own body.
  const bodyOf = name => {
    const whole = namedFunctionSource(name);
    const end = whole.indexOf('\n}\n');
    return end === -1 ? whole : whole.slice(0, end);
  };
  assert.doesNotMatch(bodyOf('ssWorkloadPageOpened'), /_sendAiMessage|ssRunStaffWorkload/,
    'refreshing the charts must never trigger a paid request');
  assert.doesNotMatch(bodyOf('ssWorkloadDataChanged'), /_sendAiMessage|ssRunStaffWorkload/);
  assert.doesNotMatch(bodyOf('ssRenderWorkloadCharts'), /_sendAiMessage/);
});

test('MB161-047: no key lock is ever taken twice on the same path', () => {
  // _serializeKeyMutation is a promise chain per key, so asking for a key the
  // caller already holds chains the request onto the very task waiting for it.
  // It can never resolve.
  //
  // _ssCommitSplitWorkbook runs INSIDE the 'spreadsheets' mutation and used to
  // take that lock again to write the index. It only bites when the index
  // changes — an ordinary cell edit rewrites a project document and leaves the
  // index alone — which is why it looked intermittent: importing froze at
  // "Saving…", deleting hung, and the sync badge stuck because the queue behind
  // it never moved again.
  // namedFunctionSource stops at the next `\nfunction `, and the neighbour here
  // is `async function`, so the slice overruns into the migration — which uses
  // that lock legitimately, because it runs outside the save path. Bound it.
  const whole = namedFunctionSource('_ssCommitSplitWorkbook');
  const commit = whole.slice(0, whole.indexOf('\n}\n') + 2);
  assert.ok(commit.includes('_ssReadStoredWorkbook()'), 'the slice covers the real body');
  assert.doesNotMatch(commit, /_serializeKeyMutation\('spreadsheets'/,
    "the caller already holds 'spreadsheets'; taking it again deadlocks");
  // The index is still written, just directly.
  assert.match(commit, /await _commitEncryptedSnapshot\('spreadsheets', JSON\.stringify\(nextIndex\)/);
  // Per-project keys are different keys, so those locks are correct and stay.
  assert.match(commit, /await _serializeKeyMutation\(key, async \(\) => \{/);

  // And the save path really is the holder, which is what makes the above true.
  assert.match(script, /const write = _serializeKeyMutation\('spreadsheets', async \(\) => \{/);

  // The migration writes the index under the lock, which is correct because it
  // runs outside the save path — fire-and-forget from the loader.
  assert.match(script, /_ssMigrateToSplitStorage\(\)\.catch\(\(\) => \{\}\)/);
});

test('MB161-049: Save All cannot wait forever', () => {
  // It awaits the save queue, so anything stuck in that queue took the button
  // with it — permanently, with no error and no way back but relaunching. That
  // is how the MB161-047 deadlock presented here: "Saving…" and nothing else.
  //
  // A timeout does not make a stuck write succeed. It makes it sayable, which
  // is the difference between a bug somebody can report and one they can only
  // describe as "it froze".
  const save = namedFunctionSource('saveAllData');
  assert.match(save, /_withTimeout\(_flushSpreadsheetSave\(\), 30000/);
  assert.match(save, /_withTimeout\(STORE\.flush\(keys\), 30000/);
  assert.match(save, /_withTimeout\(\s*\n?\s*STORE\.flush\(keys, \{ includeSync: true, requireSync: true \}\), 60000/);
  // Every await in the function is bounded; an unbounded one reintroduces it.
  for (const [, awaited] of save.matchAll(/await (\w+[^;]*);/g)) {
    assert.ok(awaited.startsWith('_withTimeout('),
      `unbounded await in Save All: ${awaited.slice(0, 60)}`);
  }
  // MB1188-015: the message is stage-specific now. The same wrapper guards the
  // local write and the cloud write, and telling somebody their work is "saved
  // locally" when it was the LOCAL step that timed out is a reassurance we
  // cannot support.
  const wrapper = namedFunctionSource('_withTimeout');
  assert.match(wrapper, /may not be written to this Mac yet/, 'the local stage is honest');
  assert.match(wrapper, /saved on this Mac; it has not reached the cloud yet/);
  assert.match(save, /'Saving the spreadsheets', true\)/, 'local stages are marked local');
  assert.match(save, /'The local save', true\)/);
});

test('MB1188-006: automatic Google checking starts on the path people use', () => {
  // I put ssStartAutoSync in ssSwitchProject, which had NO call sites — every
  // project card calls ssOpenProject. So Settings promised the app checks
  // Google every few minutes and nothing was ever scheduled. Nothing failed,
  // nothing errored; the feature simply did not exist at runtime.
  const open = namedFunctionSource('ssOpenProject');
  assert.match(open, /ssStartAutoSync\(\);/);
  assert.match(open, /ssAutoSyncTick\(true\);/, 'and checks immediately, not in three minutes');

  // The dead function is gone rather than left to be rediscovered.
  assert.ok(!/function ssSwitchProject\(/.test(script),
    'ssSwitchProject had no callers and has been removed');

  // The cards really do call ssOpenProject — the premise of the whole fix.
  assert.match(source, /class="ss-proj-card" onclick="ssOpenProject\(/);
});

test('MB1188-006: every renderer function is reachable from somewhere', () => {
  // The bug above was a function nobody called. Cheap to check for the rest of
  // the spreadsheet surface: a handler with no call site and no onclick is
  // either dead code or a feature that silently does not exist.
  const declared = [...script.matchAll(/^(?:async )?function (ss[A-Z]\w+)\(/gm)].map(m => m[1]);
  assert.ok(declared.length > 20, 'found the spreadsheet functions');
  const orphans = declared.filter(name => {
    const needle = name + '(';
    const calls = script.split(needle).length - 1;
    const markup = source.split(needle).length - 1;
    return calls <= 1 && markup <= 1;   // its own declaration only
  });
  assert.deepEqual(orphans, [], `unreachable: ${orphans.join(', ')}`);
});

test('MB1188-019: typing in the formula bar and clicking away saves it', () => {
  // The formula bar's onblur called ssUpdateToolbar(), which only repaints —
  // so anything typed there was DISCARDED the moment focus left. ssFormulaBarBlur
  // (which commits) and ssFormulaBarFocus (which closes an open inline edit
  // first) both existed and neither was wired to anything.
  //
  // This is almost certainly the "I typed in a cell, clicked another cell, came
  // back and the text was gone" report I could not trace by reading the edit
  // path — because the loss was not in the edit path at all.
  assert.match(source, /onfocus="ssFormulaBarFocus\(\)" onblur="ssFormulaBarBlur\(event\)"/);
  assert.doesNotMatch(source, /id="ss-formula-bar"[\s\S]{0,300}?onblur="ssUpdateToolbar\(\)"/,
    'onblur must commit, not merely repaint');

  const blur = namedFunctionSource('ssFormulaBarBlur');
  assert.match(blur, /if \(e\.target\.value !== currentVal\)/, 'only saves a real change');
  assert.match(blur, /ssPushUndo\(\)/, 'and it is undoable');
  assert.match(blur, /sheet\.cells\[k\] = \{ \.\.\.\(sheet\.cells\[k\] \|\| \{\}\), v: ssBoundedCellValue\(e\.target\.value\) \}/);
  assert.match(blur, /ssSave\(\)/);
});

test('MB1188-004/005: the pull holds ids, never objects, across its awaits', () => {
  // `project`, `link` and each `target` were captured before the loop, and the
  // first `await ssSave()` replaces _ssData with a freshly normalized clone. So
  // from tab two onward the writes landed in a detached copy: a six-tab pull
  // persisted tab one, reported all six, advanced no checkpoint — so the next
  // pull repeated the whole thing — and silently dropped any conflict it had
  // just told the user was kept.
  const pull = namedFunctionSource('ssPullFromGoogle');

  // Only ids and plain values survive the loop boundary. `projectId` is the
  // function's own parameter — it used to be redeclared inside the try as
  // well, which shadowed it and made the catch below look like a scoping bug.
  assert.match(pull, /^function ssPullFromGoogle\(projectId, options\)/);
  assert.doesNotMatch(pull, /const projectId = /, 'not shadowed');
  assert.match(pull, /const plan = linked\.map\(entry => \(\{ sheetId: entry\.sheet\.id, tab: entry\.tab \}\)\);/);
  assert.match(pull, /for \(const \{ sheetId, tab \} of plan\)/);

  // The live objects are re-acquired after the read, which is itself an await.
  assert.match(pull, /const live = \(_ssData\?\.projects \|\| \[\]\)\.find\(entry => entry\.id === projectId\)/);
  assert.match(pull, /const target = \(live\.sheets \|\| \[\]\)\.find\(entry => entry\.id === sheetId\)/);
  // And the case where it vanished mid-pull is handled rather than crashed on.
  assert.match(pull, /if \(!live\) break;/);
  assert.match(pull, /if \(!target\) continue;/);
  assert.match(pull, /if \(!liveLink\) break;/);

  // Nothing accumulates outside the loop any more.
  assert.doesNotMatch(pull, /const tabs = \{ \.\.\.link\.tabs \};/);
  assert.doesNotMatch(pull, /project\.googleLink = \{/,
    'the detached project reference must not be written to');

  // Cells, checkpoint, link and conflicts all go into the live workbook before
  // the save that persists them.
  const write = pull.indexOf('live.googleLink = {');
  const conflict = pull.indexOf('_ssData._conflicts = [');
  const save = pull.indexOf('const saving = ssSave();');
  assert.ok(write > -1 && conflict > -1 && save > -1);
  assert.ok(write < save && conflict < save,
    'a checkpoint that advances without its cells, or a conflict announced but not stored, is worse than skipping the tab');
});

test('MB1188-002: importing does not revert the studio to legacy storage', () => {
  // The 'spreadsheets' key is the INDEX under split storage. Writing a whole
  // workbook into it undid the per-project isolation, made migration run again
  // on the next launch, and put every project back in one contended document.
  const build = namedFunctionSource('ssImportBuildProject');
  assert.match(build, /if \(_ssStorageMode\(\) === 'split'\) \{/);
  const split = build.slice(build.indexOf("if (_ssStorageMode() === 'split')"), build.indexOf('} else {'));
  assert.doesNotMatch(split, /STORE\.replace/,
    'a split store commits through the normal save path, not a whole-key write');
  assert.match(split, /_ssData = normalized;\s*\n\s*await _flushSpreadsheetSave\(\);/);
  // The legacy branch survives for a Mac that has not migrated, where the key
  // really does hold a workbook.
  assert.match(build, /await STORE\.replace\('spreadsheets', normalized, \{ authoritative: 'confirmed workbook import' \}\)/);
});

// ── MB1188-012: a Google link survives a rename, and says when it does not ──

test('MB1188-012: the pull resolves tabs by Google sheetId, not by title', () => {
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /_googleSheets\(\)\.describe\(\{ url: spreadsheetId \}\)/,
    'it asks what the tabs are called now, before reading any of them');
  assert.match(pull, /Number\.isSafeInteger\(tab\.sheetId\) \? bySheetId\.get\(tab\.sheetId\) : null/,
    'id first');
  assert.match(pull, /\|\| byTitle\.get\(tab\.title\)/,
    'title second, so a link written before this still works');
  assert.match(pull, /title: readTitle/,
    'and the stored title is corrected from Google');
  assert.match(pull, /Number\.isSafeInteger\(remoteTab\?\.sheetId\) \? \{ sheetId: remoteTab\.sheetId \} : \{\}/,
    'a title-only link adopts the id, so it is rename-proof from then on');
});

test('MB1188-012: the read window follows the tab, not the size frozen at import', () => {
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /Math\.max\(readRows, Math\.min\(remoteTab\?\.rows \|\| 0, MAX_SPREADSHEET_ROWS\)\)/,
    'growth beyond the imported window is observable');
  assert.match(pull, /Math\.max\(readColumns,\s*\n?\s*Math\.min\(remoteTab\?\.columns \|\| 0, MAX_SPREADSHEET_COLS\)\)/,
    'in both directions, still inside the app ceilings');
  assert.doesNotMatch(pull, /rows: readRows, columns: readColumns/,
    'the frozen window must not be what is requested');
});

test('MB1188-012: column widths are applied on every pull, not only at import', () => {
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /\(remote\.columnWidths \|\| \[\]\)\.forEach/);
  assert.match(pull, /Number\.isFinite\(width\) && width > 0/,
    'a hidden column reports 0 in Google and must not collapse the column here');
});

test('MB1188-012: a failed background sync leaves a durable trace', () => {
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /lastError: String\(error\?\.message \|\| error\)/,
    'a silent failure looked exactly like a link with nothing to report');
  assert.match(pull, /lastErrorAt: new Date\(\)\.toISOString\(\)/);
  assert.match(pull, /lastError: null,/, 'and a completed sync clears it');
  // MB1188-026: recorded per Mac, so noticing a failure costs no cloud write.
  assert.match(pull, /_ssWriteLinkState\(projectId, \{/);
  assert.match(namedFunctionSource('_ssGoogleLinkNotice'), /state\.lastError/,
    'the project card shows it');
});

test('MB1188-012: tabs added in Google after the import are reported', () => {
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /newTabs: discovered\.length \? discovered\.slice\(0, 25\) : null/);
  assert.match(namedFunctionSource('_ssGoogleLinkNotice'), /new tab\$\{count === 1 \? '' : 's'\} in Google/);
});

test('MB1188-012: the link keeps its new fields through validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Round-tripping is what matters: a field the normalizer drops is a field
  // that survives exactly until the next save.
  for (const field of ['lastError', 'lastErrorAt', 'newTabs']) {
    assert.match(source, new RegExp(`googleLink\\.${field} =|'${field}'`),
      `${field} is preserved by normalizeSpreadsheetWorkbook`);
  }
});

test('MB1188-012: every page id has a title, so none renders its route key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const titles = source.slice(source.indexOf('const PAGE_TITLES'),
    source.indexOf('};', source.indexOf('const PAGE_TITLES')));
  const pages = [...source.matchAll(/id="page-([a-z-]+)"/g)].map(match => match[1]);
  for (const page of new Set(pages)) {
    assert.match(titles, new RegExp(`^\\s*${page}:`, 'm'),
      `page-${page} needs an entry in PAGE_TITLES or the top bar shows "${page}"`);
  }
});

test('MB1188-007: no caller awaits between reading a shared list and saving it', () => {
  // _persistRecordList derives its base from the stored value at save time.
  // That equals what the caller read only while nothing is awaited in between.
  // An await introduced there would make a record another Mac added in the
  // window look like a deletion this caller intended — the original bug,
  // reintroduced one level up. Callers that must await are expected to pass
  // options.base instead, which this check allows for.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const readers = {
    'getTodos()': ['persistTodos(', 'saveTodos('],
    'getAssignedTasks()': ['persistAssignedTasks(', 'saveAssignedTasks('],
    'getPolicies()': ['savePolicies('],
    'getStepUpReceipts()': ['saveStepUpReceipts('],
  };
  const lines = source.split('\n');
  const offences = [];
  for (const [reader, savers] of Object.entries(readers)) {
    lines.forEach((line, index) => {
      if (!line.includes(reader)) return;
      // Walk forward to the first save of the same list.
      let awaited = null;
      for (let cursor = index + 1; cursor < Math.min(index + 60, lines.length); cursor++) {
        const ahead = lines[cursor];
        if (savers.some(saver => ahead.includes(saver))) {
          if (awaited !== null && !ahead.includes('base:')) {
            offences.push(`${reader} at line ${index + 1}: awaits at line ${awaited + 1} ` +
              `before saving at line ${cursor + 1}`);
          }
          return;
        }
        // A later read of the same list supersedes this one; it gets its own
        // pass. Without this, a read used only for a count is paired with a
        // save that belongs to a different read entirely.
        if (ahead.includes(reader)) return;
        if (/\bawait\b/.test(ahead) && awaited === null) awaited = cursor;
        if (/^(async )?function /.test(ahead)) return;  // left the function
      }
    });
  }
  assert.deepEqual(offences, [],
    'pass options.base with the list you read, or move the read after the await');
});

test('the morning briefing has no dead sections', () => {
  // Waitlist and trials sat on the briefing reading `waitlist` and
  // `trial_lessons`, which nothing writes and which are not synchronized keys.
  // It could only ever say "no activity" — a permanent row of nothing.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = source.indexOf('<!-- Morning Briefing');
  const modal = start >= 0 ? source.slice(start, source.indexOf('</div>\n  </div>', start)) : source;
  for (const gone of ['briefing-regs', 'Waitlist &amp; Recent Trials', 'Waitlist & Recent Trials']) {
    assert.ok(!modal.includes(gone), `${gone} is gone from the briefing`);
  }
  assert.ok(!source.includes("STORE.get('waitlist'"), 'and nothing reads the dead key');
  assert.ok(!source.includes("STORE.get('trial_lessons'"), 'or the other one');
  // Every empty placeholder in the briefing must have something that fills it.
  // Scoped to `<div id="x"></div>` — those are the render targets. Wrapper
  // elements that only carry styling are not, and requiring those to be
  // referenced would fail on markup that is doing nothing wrong.
  for (const [, id] of source.matchAll(/<div id="(briefing-[a-z-]+)"><\/div>/g)) {
    assert.ok(source.includes(`getElementById('${id}')`),
      `${id} is an empty placeholder that nothing fills — a permanently blank section`);
  }
});

test('gridlines darken with zoom without changing layout', () => {
  // First attempt scaled border-width by 1/zoom. It kept the line crisp and it
  // broke zooming: border-width is layout, so every step resized the rows,
  // which resized the content, which moved the scroll target the
  // pointer-anchored zoom was aiming at. The grid juddered instead of gliding.
  // Colour is layout-neutral, so it can change on every wheel event for free.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /border:1px solid var\(--ss-line-color, #83888d\)/,
    'the WIDTH is fixed at 1px');
  const apply = namedFunctionSource('ssApplyZoom');
  assert.doesNotMatch(apply, /--ss-line'/, 'nothing sets a width variable');
  assert.match(apply, /setProperty\('--ss-line-color', _ssGridLineColor\(_ssZoom\)\)/);

  const context = vm.createContext({ Math, Number, String });
  vm.runInContext(`${namedFunctionSource('_ssGridLineColor')}
    globalThis.line = z => _ssGridLineColor(z);`, context);
  assert.equal(context.line(1), '#83888d', 'unchanged at 100%');
  assert.equal(context.line(2), '#83888d', 'and no darker when zoomed in');
  assert.equal(context.line(0.5), '#3c4043', 'darkest at the 50% floor');
  // Monotonic, so there is no zoom level where the line suddenly jumps.
  const luminance = hex => parseInt(hex.slice(1, 3), 16);
  let previous = 0;
  for (const zoom of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
    const value = luminance(context.line(zoom));
    assert.ok(value >= previous, `line gets lighter as zoom rises (${zoom})`);
    previous = value;
  }
});

test('MB1188-022: the live sync listener reads the workbook, not the index', () => {
  // Under split storage the 'spreadsheets' key is the INDEX — a list of project
  // ids. Normalizing that as a workbook throws on every sync event; the catch
  // swallowed it and the early return meant nothing re-rendered, so changes
  // arriving from another Mac were never shown. MB161-040 fixed exactly this
  // in the save path and this listener was missed.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = source.indexOf("document.addEventListener('tmb_sync_spreadsheets'");
  assert.notEqual(start, -1, 'the listener exists');
  const body = source.slice(start, source.indexOf('\n});', start) + 4);
  assert.doesNotMatch(body, /normalizeSpreadsheetWorkbook\(STORE\.get\('spreadsheets'/,
    'the raw key is the index, not a workbook');
  assert.match(body, /_ssDurableWorkbook\(\)/, 'the assembled workbook is what it needs');
  assert.match(body, /ssRenderActivityBar\(\)/,
    'and an arriving change re-renders who is credited, not only the cells');
});

test('MB1188-026: a Google check that finds nothing new writes nothing to the cloud', () => {
  // The project document reached revision 447 in one evening for about twenty
  // real edits. Every automatic check stamped a fresh `pulledAt` into the
  // SYNCED link, so the document differed every time and the "only write when
  // something actually changed" guard in _ssCommitSplitWorkbook could never
  // fire. Each of those writes re-encrypted and uploaded the whole six-sheet
  // workbook.
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.doesNotMatch(pull, /pulledAt: new Date\(\)\.toISOString\(\),\s*\n\s*tabs:/,
    'the shared link must not carry a fresh timestamp on every check');
  assert.match(pull, /_ssWriteLinkState\(projectId, \{\s*\n\s*pulledAt:/,
    'when this Mac last checked is recorded locally');

  // Four saves per pull became one per tab that actually changed.
  const saves = (pull.match(/ssSave\(\)/g) || []).length;
  assert.ok(saves <= 2, `a pull should not save more than once per tab, found ${saves}`);

  // And the fields are gone from the synced document entirely.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = source.indexOf('googleLink = {\n        spreadsheetId,');
  assert.notEqual(start, -1, 'the normalizer builds the link');
  const built = source.slice(start, source.indexOf('const readCheckpoint', start));
  for (const field of ['pulledAt', 'lastError', 'lastErrorAt', 'newTabs']) {
    assert.ok(!built.includes(`googleLink.${field} =`),
      `${field} is a per-Mac observation and must not be carried into shared data`);
  }
});

test('MB1188-026: per-Mac link state round-trips and drops empties', () => {
  const store = new Map();
  const context = vm.createContext({
    JSON, Object, Array, String,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
  vm.runInContext(`
    ${namedFunctionSource('_ssLinkStateKey')}
    ${namedFunctionSource('_ssReadLinkState')}
    ${namedFunctionSource('_ssWriteLinkState')}
    globalThis.read = id => _ssReadLinkState(id);
    globalThis.write = (id, patch) => _ssWriteLinkState(id, patch);
  `, context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.read('p1'))), {}, 'unknown project is empty');
  context.write('p1', { pulledAt: '2026-08-07T22:00:00.000Z', lastError: 'boom' });
  assert.equal(context.read('p1').lastError, 'boom');
  // A successful check clears the error rather than leaving it to be believed.
  context.write('p1', { lastError: null, lastErrorAt: null });
  assert.equal(context.read('p1').lastError, undefined);
  assert.equal(context.read('p1').pulledAt, '2026-08-07T22:00:00.000Z', 'and keeps the rest');
  // Corrupt JSON must not take the project card down with it.
  store.set('tmb__gsync_p2', 'not json');
  assert.deepEqual(JSON.parse(JSON.stringify(context.read('p2'))), {});
});

// A regex "no-undef" scanner was written here and removed again. It could not
// catch the bug that motivated it — `_ssDurablyHasProject(project.id)`, where
// `project` is a callback parameter in a different scope of the same function,
// so a function-level scan sees it as declared. Distinguishing that needs real
// scope analysis, which needs a parser this project does not carry.
//
// It is gone rather than kept-with-caveats, because a test that cannot detect
// its own motivating failure invites trust it has not earned. The protection
// that actually works for this class is exercising the path: see the P0-01
// staging tests in sync-persistence, which run the real save pipeline and
// assert what reached durable storage.

// ── MB1188-063..067: what the final pass found in the comms hubs ───────────

test('MB1188-063: an email carries a durable id, not its row number', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /id: acct\.id \+ '_' \+ \(m\.id \|\| i\),/);
  assert.doesNotMatch(source, /id: acct\.id \+ '_' \+ i,/,
    'the array index was persisted and SYNCED as a durable identity');
});

test('MB1188-063: stored flags and read marks are applied to the real emails', () => {
  // This iterated DEMO_EMAILS — `const DEMO_EMAILS = []` — so the Flagged tab
  // has never worked, and read_emails_* was written on every open and never
  // read back at all.
  const apply = namedFunctionSource('applyStoredEmailFlags');
  assert.match(apply, /\(_msEmails \|\| \[\]\)\.forEach\(email => \{/);
  assert.match(apply, /email\.flagged = flagged\.has\(email\.id\);/);
  assert.match(apply, /if \(readToday\.has\(email\.id\)\) email\.unread = false;/);
  assert.doesNotMatch(apply, /DEMO_EMAILS/);
});

test('MB1188-064: a failed fetch is never drawn as an empty inbox', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /let _msFetchError = null;/);
  assert.match(source, /let _rcFetchError = null;/);
  // Recorded on failure, cleared on success.
  assert.match(namedFunctionSource('fetchRingCentralData'), /_rcFetchError = String\(/);
  assert.match(namedFunctionSource('fetchRingCentralData'), /_rcFetchError = null;/);
  // And rendered instead of the empty state.
  assert.match(source, /_msEmails === null && _msFetchError/);
  assert.match(source, /_rcConversations === null && _rcFetchError/);
  assert.match(source, /_rcVoicemails === null && _rcFetchError/);
  assert.match(namedFunctionSource('_commFailureNotice'), /This is not an empty inbox/);
});

test('MB1188-064: the auto-refresh fetches rather than only re-rendering', () => {
  // It called refreshAll() alone, so after the first load nothing new arrived
  // on its own, and after a failed first load the hub sat on "Connect
  // Microsoft 365" for the rest of the session even once Graph recovered.
  const work = namedFunctionSource('_runAutoRefreshWork');
  assert.match(work, /await Promise\.allSettled\(\[/);
  assert.match(work, /fetchMsEmails\(\)/);
  assert.match(work, /fetchRingCentralData\(\)/);
  assert.ok(work.indexOf('Promise.allSettled') < work.indexOf('refreshAll(true)'),
    'fetch first, then draw');
});

test('MB1188-065: the AI scan never clears what somebody has handled', () => {
  const analyze = namedFunctionSource('commAnalyzeAndAddTodos');
  const reset = analyze.slice(analyze.indexOf('auto-reset'), analyze.indexOf('// Sweep'));
  assert.match(reset, /STORE\.replace\('comm_analyzed_ids'/);
  assert.doesNotMatch(reset, /STORE\.replace\('comm_handled_ids'/,
    'comm_handled_ids is the only record that a voicemail or text was dealt with');
});

test('MB1188-065: message read status merges instead of overwriting', () => {
  const mark = namedFunctionSource('markRcConvRead');
  assert.match(mark, /STORE\.mutate\('rc_read_convs'/);
  assert.doesNotMatch(mark, /persistInBackground\('rc_read_convs'/,
    'the whole-value write let each Mac erase the other\'s read marks');
});

test('MB1188-066: one press sends one message', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /const _commSendInFlight = new Set\(\);/);
  const sms = namedFunctionSource('sendRcSms');
  assert.match(sms, /if \(_commSendInFlight\.has\(sendKey\)\) return;/);
  assert.match(sms, /finally \{\s*\n\s*_commSendInFlight\.delete\(sendKey\);/);
  const reply = namedFunctionSource('sendReply');
  assert.match(reply, /if \(_commSendInFlight\.has\(sendKey\)\) return false;/);
  assert.match(reply, /return await _sendReplyOnce\(emailId, box\);/);
  assert.match(reply, /finally \{\s*\n\s*_commSendInFlight\.delete\(sendKey\);/);
});

test('MB1188-067: a typed reply survives the list being rebuilt', () => {
  const render = namedFunctionSource('renderEmailList');
  assert.match(render, /const draftedReply = openReply \? openReply\.value : null;/);
  assert.match(render, /if \(rebuilt && !rebuilt\.value\) rebuilt\.value = draftedReply;/);
  // Captured before the innerHTML write, restored after it.
  assert.ok(render.indexOf('const draftedReply') < render.indexOf('container.innerHTML'));
  assert.ok(render.indexOf('container.innerHTML') < render.indexOf('rebuilt.value = draftedReply'));
});

// ── MB1188-069 pentest: the login screen must never dead-end ─────────────────
//
// `_protectedLoginProfiles` is a cache. renderLoginProfiles fills it with a
// call it deliberately does not await, and refreshProtectedLoginProfiles keeps
// the previous contents when the call fails. Executed against the real
// functions, an Operations Manager who pressed her button before that call
// returned was sent down the unprotected path, refused by main, and shown
// "Could not unlock local data. Ask the owner to sign in again." — with no
// keypad and no way through. Permanent, not just a race, whenever the status
// call was failing.

test('MB1188-069: main, not the cache, decides whether a passcode is demanded', () => {
  const select = namedFunctionSource('selectLoginUser');
  // The cache is still the fast path...
  assert.match(select, /_loginProfileIsProtected\(name\)/);
  assert.match(select, /_openStaffPasscodeKeypad\(name\);/);
  // ...but main's refusal opens the keypad regardless of what it believed.
  assert.match(select, /if \(_isStaffPasscodeDemand\(err\)\) \{/);
  assert.match(select, /_openStaffPasscodeKeypad\(name\);\s*\n\s*return;\s*\n\s*\}/);
  // And the cache is repaired so the next paint marks the profile correctly.
  assert.match(select, /void refreshProtectedLoginProfiles\(\)\.then\(\(\) => renderLoginProfiles\(\)\);/);
  // The misleading toast is now only for real unlock failures.
  const fallback = select.indexOf('Could not unlock local data');
  assert.ok(select.indexOf('_isStaffPasscodeDemand(err)') < fallback,
    'the passcode case is handled before the generic message');
});

test('MB1188-069: the keypad opener is one function, used by both callers', () => {
  const open = namedFunctionSource('_openStaffPasscodeKeypad');
  assert.match(open, /_pinMode = 'staff';/);
  assert.match(open, /_pinStaffName = name;/);
  assert.match(open, /_pinTargetLength = 4;/);
  assert.match(open, /_pinBuffer = '';/);
  // Two copies of this block would drift; that is how the dead end appeared.
  assert.equal((script.match(/_pinMode = 'staff';/g) || []).length, 1);
});

test('MB1188-069: leaving the keypad disarms the staff flow', () => {
  const back = namedFunctionSource('backToUserPick');
  assert.match(back, /_pinMode = 'owner';/);
  assert.match(back, /_pinStaffName = null;/);
  // Otherwise clicking Elizabeth next would check her passcode against a staff
  // record — or the reverse.
  const check = namedFunctionSource('checkPin');
  assert.match(check, /if \(_pinMode === 'staff'\) return _checkStaffPin\(\);/);
});

test('MB1188-069: the passcode demand is recognised by main’s own wording', () => {
  const recognise = namedFunctionSource('_isStaffPasscodeDemand');
  assert.match(recognise, /Enter your 4-digit passcode/);
  assert.match(mainSource, /throw new Error\('Enter your 4-digit passcode\.'\);/,
    'main still says exactly this — the two are matched by string');
});

// ── MB1188-070: one bad key must not stop anybody signing in ─────────────────
//
// Found on real hardware, not in the suite. `staff_passcodes` was declared with
// the wrong shape, so its write was refused and the error was recorded. That
// alone would have been a contained, per-key failure — except initEncryption
// flushed EVERY key, STORE.flush throws if any key holds an error, and it runs
// inside checkPin. The owner's passcode screen showed
// "Error: staff_passcodes: staff_passcodes expected array data" and login
// stopped there. Nobody could get into the app on that Mac.

test('MB1188-070: initEncryption flushes only the keys it migrated', () => {
  const init = namedFunctionSource('initEncryption');
  assert.match(init, /const migrated = \[\];/);
  assert.match(init, /migrated\.push\(key\);/);
  assert.match(init, /await STORE\.flush\(migrated\);/);
  // The unscoped flush inside the session-resume branch is what did the damage.
  const branch = init.slice(init.indexOf('if (await loadEncKeyFromSession())'));
  const resume = branch.slice(0, branch.indexOf('// One-time v1.0.52 migration'));
  assert.doesNotMatch(resume, /await STORE\.flush\(\);/,
    'no unscoped flush on the sign-in path');
});

test('MB1188-070: an empty migration set cannot throw on somebody else’s error', () => {
  // flush(keys) filters recorded errors to `keys`, so an empty list is a no-op
  // rather than a whole-store check. That is the property the fix relies on.
  const flush = script.slice(script.indexOf('flush: async (keys = null, options = {})'));
  const body = flush.slice(0, flush.indexOf('\n  },'));
  assert.match(body, /const wanted = keys \? new Set\(keys\) : null;/);
  assert.match(body, /\.filter\(\(\[key\]\) => !wanted \|\| wanted\.has\(key\)\)/);
});

// ── MB1188-071: a sharing failure is not a save failure ─────────────────────
//
// Main writes the vault first, so by the time the store write runs the passcode
// is already in force on this Mac. Reporting the store failure as
// "Missing or insufficient permissions" told the person their passcode was not
// set — moments before it started being demanded of them at sign-in.

test('MB1188-071: a passcode that saved locally is not reported as failed', () => {
  const share = namedFunctionSource('_shareStaffPasscodeRecord');
  assert.match(share, /await _persistStaffPasscodeRecord\(name, record\);/);
  assert.match(share, /catch \(error\)/);
  assert.match(share, /could not be shared with the other Mac yet/);
  // A warning, not a danger: something real did happen. (namedFunctionSource
  // slices to the next plain `function`, so this async one carries the next
  // declaration too — assert on the sharing toast itself, not the whole slice.)
  const notice = share.slice(share.indexOf('could not be shared') - 200,
                             share.indexOf('could not be shared') + 200);
  assert.match(notice, /'warning'\)/);
  assert.doesNotMatch(notice, /'danger'/);

  // Both callers go through it, so neither can drift back to the raw error.
  const save = namedFunctionSource('saveStaffPasscode');
  assert.match(save, /_shareStaffPasscodeRecord\(result\.name, result\.record,/);
  assert.doesNotMatch(save, /await _persistStaffPasscodeRecord\(/);
  const clear = namedFunctionSource('_clearStaffPasscode');
  assert.match(clear, /_shareStaffPasscodeRecord\(result\.name, result\.record, 'Passcode removed\.'\)/);
  assert.doesNotMatch(clear, /await _persistStaffPasscodeRecord\(/);
});

// ── Codex 1.3.12 audit: verified findings, and what stops each recurring ─────

test('P0-1 / MB1188-072: the durable workbook is never aliased to live state', () => {
  // _commitEncryptedSnapshot clones into _durableStoreSnapshots but stores the
  // caller's object in _decCache by reference. The spreadsheet save hands it
  // the live workbook, so STORE.get('spreadsheets') — a clone of _decCache —
  // returned the unsaved edit as though it were durable. _stageDirtySpreadsheetSave
  // takes its merge base from here, so no operation could be derived and the
  // edit was written away silently, with the save reported clean.
  const durable = namedFunctionSource('_ssDurableStoreValue');
  assert.match(durable, /_durableStoreSnapshots\.has\(key\)/);
  assert.match(durable, /_cloneJson\(_durableStoreSnapshots\.get\(key\)\)/);

  const reader = namedFunctionSource('_ssReadStoredWorkbook');
  assert.match(reader, /function _ssReadStoredWorkbook\(durable = false\)/);
  assert.match(reader, /const read = durable\s*\n?\s*\? \(key\) => _ssDurableStoreValue\(key\)/);
  // Both the index AND each project document must go through it; reading one
  // durably and the other from the cache would reintroduce the same skew.
  assert.match(reader, /const stored = read\('spreadsheets'\);/);
  assert.match(reader, /const doc = read\(key\);/);
  // STORE.get appears exactly once — as the LIVE half of the selector. A second
  // one would mean some value still bypasses the durable/live choice.
  assert.equal((reader.match(/STORE\.get\(/g) || []).length, 1,
    'nothing inside the reader bypasses the durable/live selector');

  const helper = namedFunctionSource('_ssDurableWorkbook');
  assert.match(helper, /_ssReadStoredWorkbook\(true\)/);
  // A baseline read must not rewrite what the LIVE workbook is waiting for.
  assert.match(helper, /const pending = _ssPendingProjectIds;/);
  assert.match(helper, /_ssPendingProjectIds = pending;/);
});

test('P0-2 / MB1188-078: a split commit records its intent before it writes', () => {
  const commit = namedFunctionSource('_ssCommitSplitWorkbook');
  const firstDocWrite = commit.indexOf("await _commitEncryptedSnapshot(key,");
  const intentWrite = commit.indexOf('_ssWriteCommitIntent(intentIds)');
  assert.ok(intentWrite !== -1 && intentWrite < firstDocWrite,
    'the intent is durable before the first document write');
  // An unrecordable intent refuses the save. Writing anyway is precisely the
  // state that produced invisible orphans.
  assert.match(commit, /could not record the save safely/);
  const clear = commit.lastIndexOf('_ssClearCommitIntent();');
  assert.ok(clear > commit.indexOf("_commitEncryptedSnapshot('spreadsheets'"),
    'and is cleared only once the index naming those documents is durable');
});

test('P0-2 / MB1188-078: recovery completes an interrupted commit but never resurrects', () => {
  const recover = namedFunctionSource('_ssRecoverInterruptedSplitCommit');
  assert.match(recover, /_ssDurableStoreValue\('spreadsheets'\)/,
    'reads the durable index, not the cache it may be mid-write on');
  // A tombstoned project is a deliberate deletion. `named` holds every id the
  // index mentions, live or tombstoned, and anything named is skipped.
  assert.match(recover, /const named = new Set\(\(index\.projects \|\| \[\]\)\.map\(entry => String\(entry\.id\)\)\);/);
  assert.match(recover, /if \(named\.has\(id\)\) continue;/);
  assert.match(recover, /if \(!doc\) continue;/, 'a document that never landed is not invented');
  assert.match(recover, /_ssClearCommitIntent\(\);/);
  // Runs before anything reads or publishes the workbook.
  const whole = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const at = whole.indexOf('_ssRecoverInterruptedSplitCommit()');
  assert.ok(at !== -1 && at < whole.indexOf('await flushPendingDirectoryPublication()'),
    'recovery runs before publication');
});

test('P0-3 / MB1188-074: a passcode that could not be applied is remembered and retried', () => {
  // _refreshForSyncKey fired the apply once; main refuses it when nobody is
  // signed in; the renderer reduced that to `false` and forgot. And the remote
  // revision is persisted BEFORE the apply, so reconciliation short-circuits
  // and it is never retried. Exactly the MB1188-047 shape, for passcodes.
  const whole = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(whole, /\.then\(ok => _setPasscodeApplyPending\(!ok\)\)/);
  assert.match(whole, /\.catch\(\(\) => _setPasscodeApplyPending\(true\)\)/);
  const flush = namedFunctionSource('flushPendingPasscodeApply');
  assert.match(flush, /if \(!_passcodeApplyPending\(\)\) return true;/);
  assert.match(flush, /_setPasscodeApplyPending\(!applied\);/);
  assert.match(flush, /refreshProtectedLoginProfiles\(\)/, 'the login cache is refreshed after');
  // Settled at login, before anything publishes.
  const at = whole.indexOf('await flushPendingPasscodeApply();');
  assert.ok(at !== -1 && at < whole.indexOf('await flushPendingDirectoryPublication();'));
});

test('P0-3 / MB1188-074: an unapplied passcode is not a way in', () => {
  const blocks = namedFunctionSource('_passcodeApplyBlocksLogin');
  assert.match(blocks, /if \(!_passcodeApplyPending\(\)\) return false;/);
  // Only the person the pending record concerns is held back. A blanket block
  // would lock out the whole studio over one unapplied record.
  assert.match(blocks, /stored\[String\(name\)\.toLocaleLowerCase\('en-US'\)\]/);
  assert.match(blocks, /record\.cleared !== true/, 'a removal is not a reason to block');
  const select = namedFunctionSource('selectLoginUser');
  assert.match(select, /_passcodeApplyBlocksLogin\(name\)/);
  assert.match(select, /Ask Elizabeth to sign in here once/, 'and it says what to do about it');
});

test('P0-3 / MB1188-074: "shared" is claimed only after the cloud takes it', () => {
  const persist = namedFunctionSource('_persistStaffPasscodeRecord');
  assert.match(persist, /includeSync: true, requireSync: true/,
    'a local flush proves only that this Mac stored it');
});

test('P1-2 / MB1188-076: an interrupted Google pull is deferred, not successful', () => {
  const pull = namedFunctionSource('ssPullFromGoogle');
  assert.match(pull, /let deferredByEditing = false;/);
  assert.match(pull, /deferredByEditing = true; break;/);
  const guard = pull.indexOf('if (deferredByEditing) {');
  assert.ok(guard !== -1, 'the deferred case returns before the success tail');
  // Everything the success tail does must be after the guard: no pulledAt, no
  // cleared error, no "Already up to date".
  assert.ok(guard < pull.indexOf('pulledAt: new Date().toISOString()'));
  // lastIndexOf: the phrase also appears in a comment earlier in the function.
  // The toast itself is the thing that must be unreachable when deferred.
  assert.ok(guard < pull.lastIndexOf("'Already up to date with Google.'"));
  assert.match(pull, /Google sync paused because you started editing/);
  assert.match(pull.slice(guard, guard + 700), /return false;/);
});

test('P1-3 / MB1188-077: a mistyped passcode cannot lock somebody out', () => {
  const save = namedFunctionSource('saveStaffPasscode');
  assert.match(save, /const confirm = document\.getElementById\('staff-pin-confirm'\)/);
  assert.match(save, /if \(next !== confirm\)/);
  // Checked before main is called, so a typo never reaches the vault.
  assert.ok(save.indexOf('if (next !== confirm)') < save.indexOf('setStaffPasscode('));
  const whole = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(whole, /id="staff-pin-confirm"/);
});

test('P1-3 / MB1188-077: the Electron wrapper is stripped, the message is not', () => {
  const plain = namedFunctionSource('_plainIpcMessage');
  assert.match(plain, /Error invoking remote method/);
  const context = vm.createContext({});
  vm.runInContext(plain + '; this.f = _plainIpcMessage;', context);
  const f = context.f;
  assert.equal(
    f(new Error("Error invoking remote method 'app-session-set-staff-passcode': Error: Your current passcode did not match.")),
    'Your current passcode did not match.');
  assert.equal(f(new Error('Choose a 4-digit passcode.')), 'Choose a 4-digit passcode.');
  assert.equal(f('plain string'), 'plain string');
});

// ── P2 / MB1188-079: the large-workbook hot path ────────────────────────────

test('P2 / MB1188-079: the merge pre-pass walks cells, not every grid position', () => {
  const grid = namedFunctionSource('ssRenderGrid');
  // A 500x100 sheet is 50,000 positions but holds at most 10,000 cells, and
  // only a cell that EXISTS can carry rs/cs. The old sweep did the full grid
  // before emitting a single row.
  assert.match(grid, /for \(const key in cells\) \{/);
  assert.doesNotMatch(grid.slice(0, grid.indexOf('for (let r = 0; r < rows; r++) {')),
    /for \(let c = 0; c < cols; c\+\+\) \{\s*\n\s*const cell = cells\[ssKey\(r,c\)\]/,
    'no full-grid sweep before the row loop');
  // And one key per cell in the innermost loop, not two.
  assert.match(grid, /const key = ssKey\(r, c\);\s*\n\s*if \(skipped\.has\(key\)\) continue;/);
  assert.match(grid, /const cell = cells\[key\] \|\| \{\};/);
});

test('P2 / MB1188-079: the narrower scan finds exactly the same merged cells', () => {
  // The optimization is only sound if the skip set is identical. Both versions
  // are executed against the same sheets and compared.
  const context = vm.createContext({});
  vm.runInContext(`
    function ssKey(r,c){ return r+','+c; }
    function oldSkip(rows, cols, cells){
      const skipped=new Set();
      for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
        const cell=cells[ssKey(r,c)]||{};
        if((cell.rs>1||cell.cs>1)&&!cell._skip){
          const rSpan=cell.rs||1,cSpan=cell.cs||1;
          for(let dr=0;dr<rSpan;dr++) for(let dc=0;dc<cSpan;dc++){
            if(dr===0&&dc===0) continue; skipped.add(ssKey(r+dr,c+dc)); } } }
      return skipped;
    }
    function newSkip(rows, cols, cells){
      const skipped=new Set();
      for(const key in cells){
        const cell=cells[key];
        if(!cell||cell._skip||!(cell.rs>1||cell.cs>1)) continue;
        const comma=key.indexOf(','); if(comma<0) continue;
        const r=+key.slice(0,comma), c=+key.slice(comma+1);
        if(!Number.isInteger(r)||!Number.isInteger(c)) continue;
        const rSpan=cell.rs||1,cSpan=cell.cs||1;
        for(let dr=0;dr<rSpan;dr++) for(let dc=0;dc<cSpan;dc++){
          if(dr===0&&dc===0) continue; skipped.add(ssKey(r+dr,c+dc)); } }
      return skipped;
    }
    this.compare = (rows, cols, cells) => {
      const a = oldSkip(rows, cols, cells), b = newSkip(rows, cols, cells);
      return a.size === b.size && [...a].every(k => b.has(k));
    };
  `, context);
  const compare = context.compare;

  assert.ok(compare(10, 10, {}), 'an empty sheet');
  assert.ok(compare(10, 10, { '0,0': { v: 'a' }, '5,5': { v: 'b' } }), 'no merges');
  assert.ok(compare(10, 10, { '0,0': { v: 'm', rs: 2, cs: 3 } }), 'one merge at the origin');
  assert.ok(compare(10, 10, { '9,9': { v: 'm', rs: 3, cs: 3 } }), 'a merge running off the edge');
  assert.ok(compare(10, 10, { '2,2': { v: 'm', rs: 2, cs: 2 }, '2,3': { _skip: true } }),
    'a covered cell that is already marked _skip');
  assert.ok(compare(10, 10, { '1,1': { v: 'm', rs: 4, cs: 1 }, '5,1': { v: 'n', cs: 4 } }),
    'row-span and column-span together');
  // Keys that could not come from ssKey must not throw or invent skips.
  assert.ok(compare(10, 10, { 'nonsense': { rs: 2 }, '1,1': { v: 'a' } }), 'a malformed key');
  assert.ok(compare(10, 10, { '1,1': null }), 'a null cell');
});

test('P2 / MB1188-079: the hot paths are instrumented', () => {
  const record = namedFunctionSource('_ssPerfRecord');
  assert.match(record, /samples\.length > 20/, 'bounded, so it cannot grow forever');
  assert.match(record, /ms >= SS_PERF_SLOW_MS/, 'quiet unless a pass is actually slow');
  const grid = namedFunctionSource('ssRenderGrid');
  assert.match(grid, /const _perfStart = performance\.now\(\);/);
  assert.match(grid, /_ssPerfRecord\('render', performance\.now\(\) - _perfStart/);
  // The sample carries the shape, so a slow render can be told from a big sheet.
  assert.match(grid, /\$\{rows\}x\$\{cols\}, \$\{Object\.keys\(cells\)\.length\} cells/);
  assert.match(namedFunctionSource('ssPerfReport'), /medianMs/);
});
