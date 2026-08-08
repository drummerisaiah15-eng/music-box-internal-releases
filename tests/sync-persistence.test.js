const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// The rules file explains why check-out is gone, so the explanation itself
// mentions the retired key. Assertions about what the rules *do* must look at
// the expressions, not the prose.
function stripRulesComments(rules) {
  return rules.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
}

const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...renderer.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const script = scripts.find(match => match[0].startsWith('<script>'))?.[1];
assert.ok(script, 'renderer inline script exists');

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function declaration(name) {
  const starts = [
    script.indexOf(`function ${name}(`),
    script.indexOf(`async function ${name}(`),
  ].filter(index => index >= 0);
  assert.ok(starts.length, `${name} exists`);
  const start = Math.min(...starts);
  const candidates = [
    script.indexOf('\nfunction ', start + 1),
    script.indexOf('\nasync function ', start + 1),
    script.indexOf('\nclass ', start + 1),
  ].filter(index => index >= 0);
  return script.slice(start, candidates.length ? Math.min(...candidates) : script.length);
}

function classDeclaration(name) {
  const start = script.indexOf(`class ${name} `);
  assert.notEqual(start, -1, `${name} exists`);
  const next = script.indexOf('\nfunction ', start + 1);
  assert.notEqual(next, -1, `declaration after ${name} exists`);
  return script.slice(start, next);
}

function contextWith(values = {}) {
  return vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    crypto: globalThis.crypto,
    BigInt,
    showToast() {},
    _decCache: {},
    // Declared beside the functions in index.html, so some declaration()
    // slices carry them and some do not. Supplying them as context globals
    // works either way: a lexical declaration in the script simply shadows it.
    SPREADSHEET_PROJECT_KEY_PREFIX: 'spreadsheet_',
    SPREADSHEET_PROJECT_ID_PATTERN: /^[A-Za-z0-9_-]{1,100}$/,
    SPREADSHEET_INDEX_SCHEMA: 2,
    MAX_SPREADSHEET_PROJECTS: 25,
    // Some harnesses pick this up incidentally via declaration('_ssCellIsBlank');
    // others do not extract it at all. A context global covers both without
    // colliding with a lexical declaration.
    MAX_SPREADSHEET_CONFLICTS: 200,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Date,
    JSON,
    Number,
    Map,
    Set,
    Promise,
    queueMicrotask,
    atob,
    btoa,
    ...values,
  });
}

test('rapid same-key writes retain immutable operation ancestry until each acknowledgement', () => {
  const localStorage = new MemoryStorage({
    tmb_logs: 'E:encrypted-local-value',
    tmb_logs_revision: '0',
  });
  const context = contextWith({ localStorage });
  vm.runInContext(`    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_syncMergeStrategy')}

    const SYNC_PENDING_STORAGE_VERSION = 1;
    const MAX_SYNC_SUPERSEDED_OPS = 32;
    ${declaration('_pendingSyncStorageKey')}
    ${declaration('_localSyncRevision')}
    ${declaration('_validatePendingSyncRecord')}
    ${declaration('_readPendingSyncRecord')}
    var SYNC_MERGE_STRATEGIES = { logs: 'tombstoned-record-list', staff_directory: 'tombstoned-record-list', spreadsheets: 'spreadsheet-operations' };
    ${declaration('_needsMergeBase')}
    ${declaration('_writePendingSyncRecord')}
    ${declaration('_acknowledgePendingSyncRecord')}
    globalThis.pendingApi = {
      read: _readPendingSyncRecord,
      write: _writePendingSyncRecord,
      acknowledge: _acknowledgePendingSyncRecord,
    };
  `, context);

  context.pendingApi.write('logs', 'device:operation-A', 'E:ciphertext-A');
  context.pendingApi.write('logs', 'device:operation-B', 'E:ciphertext-B');
  let pending = context.pendingApi.read('logs');
  assert.equal(pending.opId, 'device:operation-B');
  assert.deepEqual([...pending.supersededOpIds], ['device:operation-A']);
  assert.equal(pending.baseRevision, 0);
  assert.equal(pending.localCiphertext, 'E:ciphertext-B');

  context.pendingApi.acknowledge('logs', 'device:operation-A', 1);
  pending = context.pendingApi.read('logs');
  assert.equal(pending.opId, 'device:operation-B', 'newer write is not cleared by the older acknowledgement');
  assert.equal(pending.baseRevision, 1, 'newer CAS advances from the acknowledged predecessor');

  context.pendingApi.acknowledge('logs', 'device:operation-B', 2);
  assert.equal(context.pendingApi.read('logs'), null);
});

test('writes held during Firebase bootstrap are drained only after bootstrap completes', async () => {
  let pending = true;
  let drains = 0;
  const context = contextWith({
    _syncReady: true,
    _syncBootstrapComplete: false,
    _syncBootstrapFailedKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    _readPendingSyncRecord: () => pending ? { opId: 'pending-op' } : null,
    getSyncKeys: () => ['logs'],
    _surfaceSyncDeliveryError: () => {},
    _drainSyncKey: async () => {
      drains++;
      pending = false;
      return true;
    },
  });
  vm.runInContext(`
    ${declaration('_scheduleSyncDrain')}
    var _legacyCheckoutSweepDone = false;
    ${declaration('_isLegacyCheckoutKey')}
    ${declaration('_retireLegacyCheckoutDeliveries')}
    ${declaration('_flushSyncDeliveries')}
    ${declaration('_drainPendingSyncWrites')}
    globalThis.bootstrapApi = {
      schedule: _scheduleSyncDrain,
      drainAll: _drainPendingSyncWrites,
      complete: () => { _syncBootstrapComplete = true; },
    };
  `, context);

  assert.equal(await context.bootstrapApi.schedule('logs'), false);
  assert.equal(drains, 0, 'bootstrap-blocked write remains pending');
  context.bootstrapApi.complete();
  assert.equal(await context.bootstrapApi.drainAll(['logs']), true);
  assert.equal(drains, 1, 'post-bootstrap drain delivers the pending write');
});

test('a local log added during remote decode preserves the unrelated cloud log', async () => {
  // V159-002: the local operation is created from the base the user could see
  // (['base']). While it waits for the per-key lock, remote reconciliation
  // commits ['base', 'cloud-new']. The local operation must be applied to the
  // reconciled base, not blindly overwrite it with its own stale snapshot.
  const localStorage = new MemoryStorage({
    tmb_logs: 'E:["base"]',
    tmb_logs_revision: '0',
  });
  const pendingRecords = new Map();
  let remoteStartedResolve;
  let releaseRemoteDecode;
  const remoteStarted = new Promise(resolve => { remoteStartedResolve = resolve; });
  const remoteDecodeGate = new Promise(resolve => { releaseRemoteDecode = resolve; });
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: Object.assign(Object.create(null), { logs: ['base'] }),
    _durableStoreSnapshots: new Map([['logs', ['base']]]),
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    _lockedStorageKeys: new Set(),
    _storeWriteChains: new Map(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _optimisticStoreValues: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    isSyncKey: key => key === 'logs',
    _newOperationId: () => 'local-operation-1234',
    _aesEncrypt: async plaintext => 'E:' + plaintext,
    _aesDecrypt: async ciphertext => ciphertext.slice(2),
    _writePendingSyncRecord: (key, opId, ciphertext) => {
      const record = { key, opId, localCiphertext: ciphertext };
      pendingRecords.set(key, record);
      return record;
    },
    _normalizeSyncValue: (_key, value) => JSON.parse(JSON.stringify(value)),
    _scheduleSyncDrain: async () => false,
    _markRemoteStarted: () => remoteStartedResolve(),
  });
  vm.runInContext(`
    ${declaration('_serializeKeyMutation')}
    ${declaration('_serializeKeyReconcile')}
    ${declaration('_commitEncryptedSnapshot')}
    ${declaration('_readSyncMutationBase')}
    ${declaration('_queueEncryptedMutation')}
    ${declaration('_digestOfValue')}
    ${declaration('_readSyncMutationBase')}
    ${declaration('_queueEncryptedWrite')}
    ${declaration('_persistRemoteValue')}
    globalThis.mutationApi = {
      applyRemote: gate => _serializeKeyReconcile('logs', async () => {
        _markRemoteStarted();
        await gate;
        return _persistRemoteValue('logs', ['base', 'cloud-new'], 6);
      }),
      // The user appended one log to the list they could see. The intent is
      // "add local-new", not "replace the whole array with this snapshot".
      writeLocal: () => _queueEncryptedMutation('logs', current => [...current, 'local-new'], {
        operationId: 'local-operation-1234',
      }),
      cached: () => _decCache.logs,
    };
  `, context);

  const remote = context.mutationApi.applyRemote(remoteDecodeGate);
  await remoteStarted;
  const local = context.mutationApi.writeLocal();
  await new Promise(resolve => setImmediate(resolve));
  releaseRemoteDecode();
  await Promise.all([remote, local]);

  assert.deepEqual(
    [...context.mutationApi.cached()],
    ['base', 'cloud-new', 'local-new'],
    'unrelated cloud log must survive'
  );
  assert.equal(localStorage.getItem('tmb_logs'), 'E:["base","cloud-new","local-new"]');
  assert.equal(
    pendingRecords.get('logs').localCiphertext,
    'E:["base","cloud-new","local-new"]',
    'the delivered ciphertext must contain both additions'
  );
  assert.equal(localStorage.getItem('tmb_logs_revision'), '6');
});

test('spreadsheet typing in A1 preserves an unrelated remote edit in B1', async () => {
  // V159-002: the remote reconcile writes B1 while the editor holds a dirty
  // workbook snapshot taken before that reconcile. Committing the whole stale
  // workbook silently erases B1. The local edit must be applied to the
  // reconciled base so both cells survive.
  const initial = {
    activeProject: 'p1',
    projects: [{
      id: 'p1',
      name: 'Schedule',
      activeId: 's1',
      sheets: [{
        id: 's1',
        name: 'Monday',
        rows: 2,
        cols: 2,
        colWidths: [100, 100],
        cells: { '0,0': { v: 'initial', bg: '', tc: '', b: false } },
      }],
    }],
  };
  const remoteValue = structuredClone(initial);
  remoteValue.projects[0].sheets[0].cells['0,1'] =
    { v: 'remote-only', bg: '', tc: '', b: false };
  let remoteStartedResolve;
  let releaseRemote;
  const remoteStarted = new Promise(resolve => { remoteStartedResolve = resolve; });
  const remoteGate = new Promise(resolve => { releaseRemote = resolve; });
  const events = [];
  const context = contextWith({
    initial,
    remoteValue,
    events,
    remoteStartedResolve,
    setTimeout,
    clearTimeout,
    document: { getElementById: () => null },
    showToast: message => events.push(`toast:${message}`),
    ssGoHome: () => events.push('home'),
    ssRender: () => {},
    refreshDashboard: () => {},
  });
  vm.runInContext(`
    const MAX_SPREADSHEET_CELL_CHARS = 50000;
    const MAX_SPREADSHEET_SHEETS = 25;
    const MAX_SPREADSHEET_ROWS = 500;
    const MAX_SPREADSHEET_COLS = 100;
    const MAX_SPREADSHEET_GRID_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CHARS = 400000;
    const MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000;
    const _keyMutationChains = new Map();
    const _storeWriteChains = new Map();
    const _storeWriteErrors = new Map();
    const _durableStoreSnapshots = new Map([['spreadsheets', JSON.parse(JSON.stringify(initial))]]);
    const _decCache = { spreadsheets: JSON.parse(JSON.stringify(initial)) };
    const _syncReady = false;
    const _syncBootstrapComplete = false;
    const STORE = { flush: async () => true };
    const _cloneJson = value => JSON.parse(JSON.stringify(value));
    const _newOperationId = () => 'spreadsheet-local-operation';
    const _scheduleSyncDrain = async () => false;
    async function _commitEncryptedSnapshot(key, serialized, normalized) {
      events.push('local-commit');
      _decCache[key] = JSON.parse(serialized);
      _durableStoreSnapshots.set(key, JSON.parse(serialized));
      return normalized;
    }
    ${declaration('_serializeKeyMutation')}
    ${declaration('_serializeKeyReconcile')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    _ssData = JSON.parse(JSON.stringify(initial));
    // MB161-012: storage is now an index plus one document per project. These
    // harnesses drive a legacy workbook, so the mode stays 'legacy' and the
    // behaviour under test is unchanged — but the functions have to exist.
    // _ssPendingProjectIds arrives with the _ssStorageMode slice below.
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('_ssAssembleWorkbook')}
    ${declaration('_ssStorageMode')}
    ${declaration('_ssReadStoredWorkbook')}
    async function _ssMigrateToSplitStorage() { return false; }
    ${declaration('_refreshForSyncKey')}
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssDigest')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellsOf')}
    ${declaration('_ssStampAttribution')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssConflictId')}
    var currentUser = () => 'Test Editor';
    ${declaration('_ssAttributionActor')}
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    ${declaration('_releaseSpreadsheetSaveGate')}
    ${declaration('_beginSpreadsheetSaveStage')}
    // MB161-040: the base is now the assembled WORKBOOK, not the raw
    // 'spreadsheets' snapshot — which under split storage is the index.
    var _ssDurableWorkbook = () => (_durableStoreSnapshots.has('spreadsheets')
      ? JSON.parse(JSON.stringify(_durableStoreSnapshots.get('spreadsheets')))
      : null);
    // _stageDirtySpreadsheetSave records who staged the change (P1-01). These
    // harnesses are not about attribution, and slicing the real helper drags in
    // a neighbouring const that collides with this sandbox's own.
    if (typeof _ssAttributionActor === 'undefined') { var _ssAttributionActor = () => 'Tester'; }
    ${declaration('_stageDirtySpreadsheetSave')}
    ${declaration('_scheduleSpreadsheetSave')}
    ${declaration('_flushSpreadsheetSave')}
    globalThis.spreadsheetRace = {
      startRemote: gate => _serializeKeyReconcile('spreadsheets', async () => {
        remoteStartedResolve();
        await gate;
        _decCache.spreadsheets = JSON.parse(JSON.stringify(remoteValue));
        _durableStoreSnapshots.set('spreadsheets', JSON.parse(JSON.stringify(remoteValue)));
        _refreshForSyncKey('spreadsheets', remoteValue);
        events.push('remote-commit');
      }),
      type: value => {
        _ssData.projects[0].sheets[0].cells['0,0'].v = value;
        return _scheduleSpreadsheetSave();
      },
      flush: _flushSpreadsheetSave,
      shown: () => _ssData.projects[0].sheets[0].cells['0,0'].v,
      durable: () => _decCache.spreadsheets.projects[0].sheets[0].cells['0,0'].v,
      durableRemoteCell: () =>
        _decCache.spreadsheets.projects[0].sheets[0].cells['0,1']?.v,
    };
  `, context);

  const remote = context.spreadsheetRace.startRemote(remoteGate);
  await remoteStarted;
  const local = context.spreadsheetRace.type('typed locally');
  assert.equal(context.spreadsheetRace.shown(), 'typed locally');
  releaseRemote();
  await remote;
  assert.equal(
    context.spreadsheetRace.shown(),
    'typed locally',
    'the remote refresh cannot replace the dirty editor value'
  );
  await context.spreadsheetRace.flush();
  await local;
  assert.deepEqual(events.filter(event => event.endsWith('commit')), [
    'remote-commit',
    'local-commit',
  ]);
  assert.equal(context.spreadsheetRace.durable(), 'typed locally');
  assert.equal(
    context.spreadsheetRace.durableRemoteCell(),
    'remote-only',
    'unrelated remote spreadsheet cell must survive'
  );
});

test('multi-key reconciliation reserves every key before waiting on predecessors', async () => {
  let releaseFirst;
  let firstStartedResolve;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
  const events = [];
  const context = contextWith({
    _keyMutationChains: new Map(),
    _events: events,
    _firstStarted: () => firstStartedResolve(),
  });
  vm.runInContext(`
    ${declaration('_serializeKeyMutation')}
    ${declaration('_serializeManyKeyMutations')}
    globalThis.lockApi = {
      one: (key, task) => _serializeKeyMutation(key, task),
      many: (keys, task) => _serializeManyKeyMutations(keys, task),
    };
  `, context);

  const predecessor = context.lockApi.one('a', async () => {
    events.push('a-start');
    firstStartedResolve();
    await firstGate;
    events.push('a-end');
  });
  await firstStarted;
  const review = context.lockApi.many(['a', 'b'], () => {
    events.push('multi-review');
  });
  const laterWrite = context.lockApi.one('b', () => {
    events.push('b-write');
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['a-start'], 'later-key mutation cannot slip ahead of the multi-key review');
  releaseFirst();
  await Promise.all([predecessor, review, laterWrite]);
  assert.deepEqual(events, ['a-start', 'a-end', 'multi-review', 'b-write']);
});

test('iCloud-applied values create durable Firebase work offline and drain after bootstrap', async () => {
  let pending = null;
  let drains = 0;
  const localStorage = new MemoryStorage();
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: Object.create(null),
    _durableStoreSnapshots: new Map(),
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    _lockedStorageKeys: new Set(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    _syncBootstrapFailedKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    isSyncKey: key => key === 'logs',
    getSyncKeys: () => ['logs'],
    _newOperationId: () => 'icloud-operation-1234',
    _aesEncrypt: async plaintext => 'E:' + plaintext,
    _normalizeSyncValue: (_key, value) => JSON.parse(JSON.stringify(value)),
    _writePendingSyncRecord: (key, opId, ciphertext) => {
      pending = { key, opId, localCiphertext: ciphertext };
      return pending;
    },
    _readPendingSyncRecord: () => pending,
    _surfaceSyncDeliveryError: () => {},
    _drainSyncKey: async () => {
      drains++;
      pending = null;
      return true;
    },
    _pendingForTest: () => pending,
  });
  vm.runInContext(`
    ${declaration('_serializeKeyMutation')}
    ${declaration('_commitEncryptedSnapshot')}
    ${declaration('_persistRemoteValue')}
    ${declaration('_scheduleSyncDrain')}
    var _legacyCheckoutSweepDone = false;
    ${declaration('_isLegacyCheckoutKey')}
    ${declaration('_retireLegacyCheckoutDeliveries')}
    ${declaration('_flushSyncDeliveries')}
    ${declaration('_drainPendingSyncWrites')}
    globalThis.icloudApi = {
      apply: () => _serializeKeyMutation('logs', () =>
        _persistRemoteValue('logs', ['from-icloud'], 9, { propagateToFirebase: true })
      ),
      connect: () => {
        _syncReady = true;
        _syncBootstrapComplete = true;
      },
      drain: () => _drainPendingSyncWrites(['logs']),
      pending: () => _pendingForTest(),
    };
  `, context);

  await context.icloudApi.apply();
  assert.equal(localStorage.getItem('tmb_logs'), 'E:["from-icloud"]');
  assert.equal(localStorage.getItem('tmb_logs_revision'), '9');
  assert.equal(context.icloudApi.pending().localCiphertext, 'E:["from-icloud"]');
  assert.equal(drains, 0, 'offline/bootstrap application remains queued');

  context.icloudApi.connect();
  assert.equal(await context.icloudApi.drain(), true);
  assert.equal(drains, 1);
  assert.equal(context.icloudApi.pending(), null);
  assert.match(
    declaration('loadFromiCloud'),
    /_persistRemoteValue\(name, entry\.value, entry\.revision, \{\s*propagateToFirebase: true/
  );
});

test('an iCloud apply rolls back if its durable Firebase pending record cannot be stored', async () => {
  class FailOnceStorage extends MemoryStorage {
    setItem(key, value) {
      if (key === this.failOnceKey) {
        this.failOnceKey = null;
        throw new Error('simulated pending-record failure');
      }
      super.setItem(key, value);
    }
  }
  const localStorage = new FailOnceStorage({
    tmb_logs: 'E:["current"]',
    tmb_logs_revision: '5',
    tmb_logs_local_ts: '2026-07-30T12:00:00.000Z',
  });
  localStorage.failOnceKey = 'tmb_logs_pending_sync';
  const cache = { logs: ['current'] };
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: cache,
    _durableStoreSnapshots: new Map([['logs', ['current']]]),
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    _lockedStorageKeys: new Set(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    isSyncKey: key => key === 'logs',
    _newOperationId: () => 'icloud-operation-1234',
    _aesEncrypt: async plaintext => 'E:' + plaintext,
    _normalizeSyncValue: (_key, value) => JSON.parse(JSON.stringify(value)),
    _scheduleSyncDrain: async () => false,
  });
  vm.runInContext(`    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_syncMergeStrategy')}

    const SYNC_PENDING_STORAGE_VERSION = 1;
    const MAX_SYNC_SUPERSEDED_OPS = 32;
    ${declaration('_pendingSyncStorageKey')}
    ${declaration('_localSyncRevision')}
    ${declaration('_validatePendingSyncRecord')}
    ${declaration('_readPendingSyncRecord')}
    var SYNC_MERGE_STRATEGIES = { logs: 'tombstoned-record-list', staff_directory: 'tombstoned-record-list', spreadsheets: 'spreadsheet-operations' };
    ${declaration('_needsMergeBase')}
    ${declaration('_writePendingSyncRecord')}
    ${declaration('_serializeKeyMutation')}
    ${declaration('_setOrRemoveStorage')}
    ${declaration('_commitEncryptedSnapshot')}
    ${declaration('_persistRemoteValue')}
    globalThis.failedIcloudApi = {
      apply: () => _serializeKeyMutation('logs', () =>
        _persistRemoteValue('logs', ['from-icloud'], 9, { propagateToFirebase: true })
      ),
      cached: () => _decCache.logs,
    };
  `, context);

  await assert.rejects(context.failedIcloudApi.apply(), /simulated pending-record failure/);
  assert.equal(localStorage.getItem('tmb_logs'), 'E:["current"]');
  assert.equal(localStorage.getItem('tmb_logs_revision'), '5');
  assert.equal(localStorage.getItem('tmb_logs_pending_sync'), null);
  assert.deepEqual([...context.failedIcloudApi.cached()], ['current']);
});

test('only an exact v1.0.52 Firestore document is accepted and queued for encrypted upgrade', async () => {
  const localStorage = new MemoryStorage();
  const cache = Object.create(null);
  const persisted = [];
  const context = contextWith({
    localStorage,
    _decCache: cache,
    _readPendingSyncRecord: () => null,
    _ensureCurrentValuePending: () => { throw new Error('no local value should be queued'); },
    _decodeSyncValue: async (_key, value) => value,
    _persistRemoteValue: async (key, value, revision, options) => {
      persisted.push({ key, value, revision, options });
      return value;
    },
    _refreshForSyncKey: () => {},
    updateSyncTimestamp: () => {},
    _syncDeliveryErrors: new Map(),
  });
  vm.runInContext(`
    const SYNC_ENVELOPE_FORMAT = 'tmb-sync-aes-gcm-v2';
    ${declaration('_localSyncRevision')}
    ${declaration('_syncDocumentKind')}
    ${declaration('_reconcileRemoteSnapshot')}
    globalThis.legacyApi = {
      reconcile: _reconcileRemoteSnapshot,
      kind: _syncDocumentKind,
    };
  `, context);

  const legacy = {
    value: ['legacy-value'],
    updated: '2026-07-30T12:00:00.000Z',
  };
  const result = await context.legacyApi.reconcile('logs', {
    exists: true,
    data: () => legacy,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.localPending, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].revision, 0);
  assert.equal(persisted[0].options.propagateToFirebase, true);

  assert.throws(
    () => context.legacyApi.kind({ ...legacy, unexpected: true }),
    /unsupported schema/
  );
  assert.throws(
    () => context.legacyApi.kind({ value: [], updated: 'not-a-v1-timestamp-value' }),
    /unsupported schema/
  );
});

test('CAS rejects a remote revision change unless the user explicitly confirms Keep This Mac', async () => {
  let remote = {
    value: { old: true },
    revision: 4,
    opId: 'other-device-operation',
    writer: 'other-device-id',
  };
  let transactionWrites = 0;
  const localStorage = new MemoryStorage({ tmb_logs_revision: '3' });
  const ref = {};
  const context = contextWith({
    localStorage,
    _syncReady: true,
    isSyncKey: key => key === 'logs',
    _firestoreDb: {
      runTransaction: async callback => callback({
        get: async () => ({ exists: true, data: () => remote }),
        set: (_ref, value) => {
          transactionWrites++;
          remote = value;
        },
      }),
    },
    _normalizeSyncValue: (_key, value) => value,
    _encodeSyncValue: async (_key, value) => ({ encrypted: value }),
    studioRef: () => ({ collection: () => ({ doc: () => ref }) }),
    _ensureCurrentValuePending: () => { throw new Error('explicit metadata expected'); },
    _deviceId: () => 'this-device-id',
    _localSyncRevision: () => Number(localStorage.getItem('tmb_logs_revision') || 0),
    _acknowledgePendingSyncRecord: () => {},
    updateSyncTimestamp: () => {},
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'server-time' } } },
  });
  vm.runInContext(`
    const MAX_SYNC_SUPERSEDED_OPS = 32;
    ${classDeclaration('SyncConflictError')}
    ${declaration('syncPush')}
    globalThis.casPush = syncPush;
  `, context);

  await assert.rejects(
    context.casPush('logs', [], {
      opId: 'this-device-operation',
      expectedRevision: 3,
      supersededOpIds: [],
    }),
    error => error?.code === 'SYNC_CONFLICT'
  );
  assert.equal(transactionWrites, 0, 'ordinary retry never overwrites the changed cloud revision');

  const result = await context.casPush('logs', [], {
    opId: 'this-device-operation',
    expectedRevision: 3,
    supersededOpIds: [],
    conflictResolution: 'keep-local-confirmed',
  });
  assert.equal(result.revision, 5);
  assert.equal(transactionWrites, 1, 'only the explicit confirmed resolution advances cloud');
});

test('CAS upgrades an exact legacy remote document to encrypted schema revision one', async () => {
  let remote = {
    value: ['legacy-value'],
    updated: '2026-07-30T12:00:00.000Z',
  };
  let transactionWrites = 0;
  const localStorage = new MemoryStorage({ tmb_logs_revision: '0' });
  const context = contextWith({
    localStorage,
    _syncReady: true,
    isSyncKey: key => key === 'logs',
    _firestoreDb: {
      runTransaction: async callback => callback({
        get: async () => ({ exists: true, data: () => remote }),
        set: (_ref, value) => {
          transactionWrites++;
          remote = value;
        },
      }),
    },
    _normalizeSyncValue: (_key, value) => value,
    _encodeSyncValue: async (_key, value) => ({
      format: 'tmb-sync-aes-gcm-v2',
      keyId: 'sync-key-id-123456',
      ciphertext: 'E:' + JSON.stringify(value),
      valueType: 'array',
    }),
    studioRef: () => ({ collection: () => ({ doc: () => ({}) }) }),
    _ensureCurrentValuePending: () => { throw new Error('explicit metadata expected'); },
    _deviceId: () => 'this-device-id-1234',
    _localSyncRevision: () => Number(localStorage.getItem('tmb_logs_revision') || 0),
    _acknowledgePendingSyncRecord: () => {},
    updateSyncTimestamp: () => {},
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'server-time' } } },
  });
  vm.runInContext(`
    const MAX_SYNC_SUPERSEDED_OPS = 32;
    ${classDeclaration('SyncConflictError')}
    ${declaration('syncPush')}
    globalThis.upgradeLegacy = syncPush;
  `, context);

  const result = await context.upgradeLegacy('logs', ['legacy-value'], {
    opId: 'upgrade-operation-1234',
    expectedRevision: 0,
    supersededOpIds: [],
  });
  assert.equal(result.revision, 1);
  assert.equal(transactionWrites, 1);
  assert.equal(remote.schemaVersion, 2);
  assert.equal(remote.revision, 1);
  assert.equal(remote.updated, undefined, 'full-document replacement removes the legacy marker');
});

test('encrypted conflict backups are bounded and the latest snapshot is recoverable', () => {
  const localStorage = new MemoryStorage({
    tmb_logs: 'E:["local"]',
    tmb_logs_revision: '4',
    tmb_logs_local_ts: '2026-07-30T12:00:00.000Z',
  });
  const context = contextWith({
    localStorage,
    _readPendingSyncRecord: () => null,
    _validatePendingSyncRecord: (_key, value) => value,
    _deviceId: () => 'device-id-for-backups',
    getSyncKeys: () => ['logs'],
    isSyncKey: key => key === 'logs',
  });
  vm.runInContext(`
    const SYNC_CONFLICT_BACKUP_INDEX_KEY = 'tmb__sync_conflict_backup_index';
    const SYNC_CONFLICT_BACKUP_POINTER_KEY = 'tmb__last_sync_conflict_backup';
    const MAX_SYNC_CONFLICT_BACKUPS = 3;
    ${declaration('_bytesToB64')}
    ${declaration('_localSyncRevision')}
    ${declaration('_readSyncConflictBackupIndex')}
    ${declaration('_validateSyncConflictBackup')}
    ${declaration('_latestSyncConflictBackup')}
    ${declaration('_pruneSyncConflictBackups')}
    ${declaration('_createSyncConflictBackup')}
    globalThis.backupApi = {
      create: resolution => _createSyncConflictBackup(
        ['logs'], resolution, { requirePending: false }
      ),
      index: _readSyncConflictBackupIndex,
      latest: _latestSyncConflictBackup,
    };
  `, context);

  for (let index = 0; index < 5; index++) {
    context.backupApi.create('backup-' + index);
  }
  const backupKeys = [...localStorage.values.keys()]
    .filter(key => key.startsWith('tmb__sync_conflict_backup_') &&
      key !== 'tmb__sync_conflict_backup_index');
  assert.equal(backupKeys.length, 3, 'only the three newest encrypted snapshots remain');
  assert.equal(context.backupApi.index().length, 3);
  assert.equal(context.backupApi.latest().backup.resolution, 'backup-4');
});

test('restore path reapplies encrypted data, preserves CAS revision, and snapshots undo state', async () => {
  const currentCiphertext = 'E:["current"]';
  const backupCiphertext = 'E:["restored"]';
  const pending = {
    version: 1,
    opId: 'current-operation-1234',
    baseRevision: 7,
    localCiphertext: currentCiphertext,
    supersededOpIds: [],
    createdAt: '2026-07-30T12:00:00.000Z',
  };
  const backupStorageKey = 'tmb__sync_conflict_backup_restore01';
  const backup = {
    version: 1,
    createdAt: '2026-07-30T12:05:00.000Z',
    resolution: 'keep-local',
    deviceId: 'device-id-for-restore',
    entries: {
      logs: {
        ciphertext: backupCiphertext,
        pending: null,
        revision: 3,
        localTimestamp: '2026-07-30T11:00:00.000Z',
      },
    },
  };
  const localStorage = new MemoryStorage({
    tmb_logs: currentCiphertext,
    tmb_logs_revision: '7',
    tmb_logs_local_ts: '2026-07-30T12:00:00.000Z',
    tmb_logs_pending_sync: JSON.stringify(pending),
    tmb__sync_conflict_backup_index: JSON.stringify([backupStorageKey]),
    tmb__last_sync_conflict_backup: backupStorageKey,
    [backupStorageKey]: JSON.stringify(backup),
  });
  const cache = { logs: ['current'] };
  const toasts = [];
  const context = contextWith({
    localStorage,
    window: { confirm: () => true },
    _encKey: {},
    _decCache: cache,
    _durableStoreSnapshots: new Map([['logs', ['current']]]),
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    _lockedStorageKeys: new Set(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _syncResolutionKeys: new Set(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    _normalizeSyncValue: (_key, value) => JSON.parse(JSON.stringify(value)),
    _aesDecrypt: async ciphertext => ciphertext.slice(2),
    _newOperationId: () => 'restored-operation-1234',
    _deviceId: () => 'device-id-for-restore',
    getSyncKeys: () => ['logs'],
    isSyncKey: key => key === 'logs',
    _refreshForSyncKey: () => {},
    _scheduleSyncDrain: async () => false,
    _updateSyncConflictActions: () => {},
    showToast: (message, kind) => toasts.push({ message, kind }),
  });
  vm.runInContext(`    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_syncMergeStrategy')}

    const SYNC_CONFLICT_BACKUP_INDEX_KEY = 'tmb__sync_conflict_backup_index';
    const SYNC_CONFLICT_BACKUP_POINTER_KEY = 'tmb__last_sync_conflict_backup';
    const MAX_SYNC_CONFLICT_BACKUPS = 3;
    ${declaration('_bytesToB64')}
    ${declaration('_pendingSyncStorageKey')}
    ${declaration('_localSyncRevision')}
    ${declaration('_validatePendingSyncRecord')}
    ${declaration('_readPendingSyncRecord')}
    var SYNC_MERGE_STRATEGIES = { logs: 'tombstoned-record-list', staff_directory: 'tombstoned-record-list', spreadsheets: 'spreadsheet-operations' };
    ${declaration('_needsMergeBase')}
    ${declaration('_writePendingSyncRecord')}
    ${declaration('_serializeKeyMutation')}
    ${declaration('_serializeManyKeyMutations')}
    ${declaration('_readSyncConflictBackupIndex')}
    ${declaration('_validateSyncConflictBackup')}
    ${declaration('_latestSyncConflictBackup')}
    ${declaration('_pruneSyncConflictBackups')}
    ${declaration('_createSyncConflictBackup')}
    ${declaration('_setOrRemoveStorage')}
    ${declaration('restoreLatestSyncConflictBackup')}
    globalThis.restoreApi = {
      restore: restoreLatestSyncConflictBackup,
      latest: _latestSyncConflictBackup,
      pending: () => _readPendingSyncRecord('logs'),
      cached: () => _decCache.logs,
    };
  `, context);

  assert.equal(await context.restoreApi.restore(), true);
  assert.equal(localStorage.getItem('tmb_logs'), backupCiphertext);
  assert.equal(localStorage.getItem('tmb_logs_revision'), '7', 'restore never rewinds the Firebase CAS base');
  assert.equal(context.restoreApi.pending().baseRevision, 7);
  assert.equal(context.restoreApi.pending().localCiphertext, backupCiphertext);
  assert.deepEqual([...context.restoreApi.cached()], ['restored']);
  const latest = context.restoreApi.latest().backup;
  assert.equal(latest.resolution, 'pre-restore');
  assert.equal(latest.entries.logs.ciphertext, currentCiphertext, 'the restore operation itself is undoable');
  assert.equal(toasts.at(-1).kind, 'success');
});

test('remote wrapper validation rejects excessive PBKDF2 work before any key derivation', () => {
  const salt = Buffer.alloc(16, 7).toString('base64');
  const ciphertext = 'E:' + Buffer.alloc(40, 9).toString('base64');
  const context = contextWith({
    PIN_KDF_ITERATIONS: 600000,
    LEGACY_PIN_KDF_ITERATIONS: 120000,
    MAX_PIN_KDF_ITERATIONS: 2000000,
    MAX_PIN_EPOCH: Number.MAX_SAFE_INTEGER - 1,
    _b64ToBytes: value => Uint8Array.from(Buffer.from(value, 'base64')),
  });
  vm.runInContext(`
    ${declaration('_validatedPinEpoch')}
    ${declaration('_validatedRemoteKdfIterations')}
    ${declaration('_validatedRemoteSalt')}
    ${declaration('_validatedWrappedCiphertext')}
    ${declaration('_validatedKeyCheck')}
    ${declaration('_validateRemotePinWrapper')}
    globalThis.validateWrapper = _validateRemotePinWrapper;
  `, context);

  assert.throws(() => context.validateWrapper({
    keyId: 'valid-key-id-1234',
    wrapSalt: salt,
    kdfIterations: 50000000,
    wrappedDek: ciphertext,
    keyCheck: ciphertext,
    pinEpoch: 2,
  }, {
    label: 'Remote test wrapper',
    saltField: 'wrapSalt',
    requireKeyId: true,
  }), /unsafe passcode derivation settings/);
});

test('staged PIN rotation commits the new local wrapper and survives a remote outage without rollback', async () => {
  const salt = Buffer.alloc(16, 3).toString('base64');
  const ciphertext = 'E:' + Buffer.alloc(40, 4).toString('base64');
  const localStorage = new MemoryStorage({
    tmb_owner_pin: 'H:old',
    tmb__ps: salt,
    tmb__pin_kdf_iterations: '600000',
    tmb__pin_length: '6',
    tmb__pin_epoch: '8',
  });
  const sessionStorage = new MemoryStorage();
  const rotation = {
    version: 1,
    rotationId: 'rotation-operation-1234',
    stage: 'staged',
    createdAt: new Date().toISOString(),
    fromEpoch: 8,
    toEpoch: 9,
    prior: {
      ownerPin: 'H:old',
      pinSalt: salt,
      pinIterations: '600000',
      pinLength: '6',
      wrappedKey: null,
      localPinWrapped: ciphertext,
      localPinSalt: salt,
      localPinIterations: '600000',
      sessionKey: null,
      pinEpoch: '8',
    },
    nextPinState: {
      hash: 'H:new',
      salt,
      iterations: 600000,
      length: 6,
    },
    localProtection: {
      keychainWrapped: null,
      pinWrapped: ciphertext,
      pinSalt: salt,
      pinIterations: 600000,
    },
    cloud: {
      required: true,
      complete: false,
      salt,
      wrappedDek: ciphertext,
      keyCheck: ciphertext,
    },
    firebase: {
      required: false,
      complete: true,
      keyId: null,
      salt: null,
      wrappedDek: null,
      keyCheck: null,
    },
  };
  localStorage.setItem('tmb__pin_rotation_v1', JSON.stringify(rotation));

  const context = contextWith({
    localStorage,
    sessionStorage,
    window: {
      electronSync: {
        read: async () => ({ ok: false, error: 'iCloud unavailable' }),
        write: async () => ({ ok: false }),
      },
    },
    ELIZABETH_PIN_KEY: 'tmb_owner_pin',
    PIN_ROTATION_STORAGE_KEY: 'tmb__pin_rotation_v1',
    PIN_EPOCH_STORAGE_KEY: 'tmb__pin_epoch',
    LOCAL_PIN_WRAPPED_KEY: 'tmb__local_pin_wrapped',
    LOCAL_PIN_SALT_KEY: 'tmb__local_pin_salt',
    LOCAL_PIN_KDF_KEY: 'tmb__local_pin_kdf_iterations',
    PIN_KDF_ITERATIONS: 600000,
    LEGACY_PIN_KDF_ITERATIONS: 120000,
    MAX_PIN_KDF_ITERATIONS: 2000000,
    MAX_PIN_EPOCH: Number.MAX_SAFE_INTEGER - 1,
    _encKey: {},
    _activePin: '654321',
    _firestoreDb: null,
    _syncEncKey: null,
    _portablePinStale: false,
    _portablePinVerifiedEpoch: null,
    _b64ToBytes: value => Uint8Array.from(Buffer.from(value, 'base64')),
    _pinMatchesHashState: async pin => pin === '654321',
    _pinMatchesCapturedState: async () => false,
  });
  vm.runInContext(`
    ${declaration('_validatedPinEpoch')}
    ${declaration('_validatedRemoteSalt')}
    ${declaration('_validatedWrappedCiphertext')}
    ${declaration('_validatedKeyCheck')}
    ${declaration('_commitPinHashState')}
    ${declaration('_setOrRemoveStorage')}
    ${declaration('_restorePinAndLocalProtection')}
    ${declaration('_commitStoredLocalProtection')}
    ${declaration('_parsePinRotation')}
    ${declaration('_savePinRotation')}
    ${declaration('_recoverPinRotationForLogin')}
    ${declaration('_resumePendingPinRotationNow')}
    globalThis.rotationApi = {
      recover: _recoverPinRotationForLogin,
      resume: _resumePendingPinRotationNow,
    };
  `, context);

  const recovered = await context.rotationApi.recover('654321');
  assert.equal(recovered.matched, true);
  assert.equal(localStorage.getItem('tmb_owner_pin'), 'H:new');
  assert.equal(localStorage.getItem('tmb__pin_epoch'), '9');
  assert.equal(JSON.parse(localStorage.getItem('tmb__pin_rotation_v1')).stage, 'local-committed');

  await assert.rejects(
    context.rotationApi.resume(),
    /iCloud unavailable/
  );
  assert.equal(localStorage.getItem('tmb_owner_pin'), 'H:new', 'remote failure never rolls the local passcode back');
  assert.equal(JSON.parse(localStorage.getItem('tmb__pin_rotation_v1')).stage, 'local-committed');
});

test('connected lifecycle flush includes cloud delivery and server bounds stay conservative', () => {
  assert.match(
    script,
    /onFlushRequested\(async \(\) => \{[\s\S]*?STORE\.flush\(null, \{[\s\S]*?includeSync: _syncReady && _syncBootstrapComplete/
  );
  assert.match(script, /const MAX_SYNC_DOCUMENT_BYTES = 880000/);
  assert.match(script, /const MAX_SYNC_CIPHERTEXT_CHARS = 880000/);
  assert.match(script, /ciphertext\.length > MAX_SYNC_CIPHERTEXT_CHARS/);
  assert.match(script, /resolveSyncConflictsUseCloud/);
  assert.match(script, /resolveSyncConflictsKeepLocal/);
  assert.match(script, /_createSyncConflictBackup\(keys, 'keep-local'/);
  assert.match(script, /restoreLatestSyncConflictBackup/);
  assert.doesNotMatch(
    declaration('_commitEncryptedSnapshot'),
    /_decCache\[k\]\s*=\s*snapshot;\s*_decCache\[k\]\s*=\s*snapshot;/
  );
  assert.equal((declaration('_persistRemoteValue').match(/_decCache\[key\]\s*=/g) || []).length, 0);
  assert.match(script, /async function _adoptCurrentPortablePin/);
  assert.match(script, /mode: 'adopt-current'/);
});

test('Firestore rules admit rotation metadata and no longer retain removed iMessage keys', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  assert.match(rules, /'pinEpoch', 'rotationId'/);
  assert.match(rules, /request\.resource\.data\.pinEpoch is int/);
  assert.match(rules, /request\.resource\.data\.rotationId == null/);
  assert.match(rules, /function writableDataKey\(keyId\)/);
  assert.doesNotMatch(stripRulesComments(rules), /checkout_/,
    'lesson check-out is retired; no date-shaped document key may remain writable');
  assert.match(rules, /writableDataKey\(keyId\) && validDataWrite\(\)/);
  assert.match(rules, /function validLegacyData\(data\)/);
  assert.match(rules, /data\.keys\(\)\.hasOnly\(\['value', 'updated'\]\)/);
  assert.match(rules, /data\.updated\.size\(\) == 24/);
  assert.match(rules, /data\.updated\.matches\(/);
  assert.match(rules, /function validOneTimeLegacyUpgrade\(\)/);
  assert.match(rules, /validLegacyData\(resource\.data\)/);
  assert.match(rules, /request\.resource\.data\.revision == 1/);
  assert.match(rules, /resource\.data\.schemaVersion == 2/);
  assert.match(rules, /validVersionedDataUpdate\(\) \|\| validOneTimeLegacyUpgrade\(\)/);
  assert.doesNotMatch(rules, /'imsg_phone'|'imsg_phones'/);
});

// --- V159-001: remote-authority lifecycle -----------------------------------

function remoteAuthorityContext(authority, { rawLocal = null } = {}) {
  let saves = 0;
  const localStorage = new MemoryStorage(rawLocal ? { tmb_spreadsheets: rawLocal } : {});
  const context = contextWith({
    localStorage,
    _remoteAuthority: authority,
    _remoteDocPresence: new Map(),
    _syncBootstrapFailedKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(),
    structuredClone,
    STORE: { get: () => null },
    ssSave: () => { saves++; return Promise.resolve(true); },
    _countSaves: () => saves,
  });
  vm.runInContext(`
    const MAX_SPREADSHEET_CELL_CHARS = 50000;
    const MAX_SPREADSHEET_SHEETS = 25;
    const MAX_SPREADSHEET_ROWS = 500;
    const MAX_SPREADSHEET_COLS = 100;
    const MAX_SPREADSHEET_GRID_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CHARS = 400000;
    const MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000;
    // _ssData, _ssBlockedWorkbook, and _ssBlockedWorkbookError come from the
    // module-level block that follows normalizeSpreadsheetWorkbook in the slice.
    function ssCreateDefaultData() {
      return {
        activeProject: 'proj_1',
        projects: [{
          id: 'proj_1',
          name: 'Color Block Schedule',
          activeId: 'proj_1_s1',
          sheets: [{
            id: 'proj_1_s1',
            name: 'Monday',
            rows: 2,
            cols: 2,
            colWidths: [90, 100],
            cells: { '0,0': { v: 'TIME', bg: '#c4922a', tc: '#ffffff', b: true } },
          }],
        }],
      };
    }
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_remoteStateIsAuthoritativelyAbsent')}
    // MB161-012: storage is now an index plus one document per project. These
    // harnesses drive a legacy workbook, so the mode stays 'legacy' and the
    // behaviour under test is unchanged — but the functions have to exist.
    // _ssPendingProjectIds arrives with the _ssStorageMode slice below.
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('_ssAssembleWorkbook')}
    ${declaration('_ssStorageMode')}
    ${declaration('_ssReadStoredWorkbook')}
    async function _ssMigrateToSplitStorage() { return false; }
    ${declaration('ssLoad')}
    globalThis.loadApi = {
      load: () => { ssLoad(); return _countSaves(); },
      absent: () => _remoteStateIsAuthoritativelyAbsent(),
    };
  `, context);
  return context.loadApi;
}

test('MB-001: opening Spreadsheets before Firebase is checked writes no default', () => {
  // The release blocker. Remote state is unknown, so a missing local value must
  // not queue an empty default workbook that can outlive restarts and block the
  // real remote workbook from loading.
  assert.equal(remoteAuthorityContext('unknown').load(), 0);
});

test('MB-001: connecting, authenticating, and bootstrapping write no default', () => {
  for (const authority of ['checking', 'connecting', 'authenticating', 'bootstrapping']) {
    assert.equal(
      remoteAuthorityContext(authority).load(),
      0,
      `${authority} must not be treated as remote absence`
    );
  }
});

test('MB-001: authentication or network failure writes no default', () => {
  // Requirement 3: a failure leaves remote state unknown, not absent.
  assert.equal(remoteAuthorityContext('error').load(), 0);
});

test('MB-001: staff credential denial writes no default', () => {
  // Requirement 4: a staff cold start that cannot obtain runtime credentials
  // must not be read as "there is no remote workbook".
  assert.equal(remoteAuthorityContext('credential-denied').load(), 0);
});

test('MB-001: a quarantined key writes no default', () => {
  assert.equal(remoteAuthorityContext('quarantined').load(), 0);
});

test('MB-001: an authoritatively absent remote writes exactly one default', () => {
  // Requirement 2: only after bootstrap confirms the remote document is absent.
  assert.equal(remoteAuthorityContext('ready-absent').load(), 1);
});

test('MB-001: an authoritatively unconfigured install writes exactly one default', () => {
  // Firebase genuinely not configured — there is no remote to preserve.
  assert.equal(remoteAuthorityContext('unconfigured').load(), 1);
});

test('MB-001: a value encrypted by another profile never writes a default', () => {
  assert.equal(
    remoteAuthorityContext('ready-absent', { rawLocal: 'E:other-profile' }).load(),
    0
  );
});

test('MB-001: only authoritative absence resolves as absent', () => {
  const absent = ['unconfigured', 'ready-absent'];
  const notAbsent = [
    'unknown', 'checking', 'connecting', 'authenticating', 'bootstrapping',
    'ready-present', 'error', 'credential-denied', 'quarantined',
  ];
  for (const authority of absent) {
    assert.equal(remoteAuthorityContext(authority).absent(), true, authority);
  }
  for (const authority of notAbsent) {
    assert.equal(remoteAuthorityContext(authority).absent(), false, authority);
  }
});

// --- V159-003: quarantined data must not be reported as synced --------------

test('MB-009: a quarantined key with a pending record fails the flush', async () => {
  // _scheduleSyncDrain returns false for a quarantined key. That skip must be
  // surfaced as incomplete, not folded into success by _flushSyncDeliveries.
  const context = contextWith({
    _syncReady: true,
    _syncBootstrapComplete: true,
    _syncBootstrapFailedKeys: new Set(['spreadsheets']),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    _readPendingSyncRecord: key => key === 'spreadsheets' ? { opId: 'pending-op' } : null,
    getSyncKeys: () => ['logs', 'spreadsheets'],
    _surfaceSyncDeliveryError: () => {},
    _drainSyncKey: async () => true,
  });
  vm.runInContext(`
    ${declaration('_scheduleSyncDrain')}
    var _legacyCheckoutSweepDone = false;
    ${declaration('_isLegacyCheckoutKey')}
    ${declaration('_retireLegacyCheckoutDeliveries')}
    ${declaration('_flushSyncDeliveries')}
    globalThis.quarantineApi = { flush: keys => _flushSyncDeliveries(keys) };
  `, context);

  await assert.rejects(
    () => context.quarantineApi.flush(['spreadsheets']),
    /quarantine/i,
    'a quarantined pending key must not report success'
  );
});

test('MB-009: healthy keys still drain while another key is quarantined', async () => {
  const drained = [];
  const context = contextWith({
    _syncReady: true,
    _syncBootstrapComplete: true,
    _syncBootstrapFailedKeys: new Set(['spreadsheets']),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    _pending: new Set(['logs', 'spreadsheets']),
    _surfaceSyncDeliveryError: () => {},
    _drainedForTest: drained,
    getSyncKeys: () => ['logs', 'spreadsheets'],
  });
  vm.runInContext(`
    const _readPendingSyncRecord = key => _pending.has(key) ? { opId: 'pending-op' } : null;
    const _drainSyncKey = async key => {
      _drainedForTest.push(key);
      _pending.delete(key);
      return true;
    };
    ${declaration('_scheduleSyncDrain')}
    var _legacyCheckoutSweepDone = false;
    ${declaration('_isLegacyCheckoutKey')}
    ${declaration('_retireLegacyCheckoutDeliveries')}
    ${declaration('_flushSyncDeliveries')}
    globalThis.quarantineApi = {
      flush: keys => _flushSyncDeliveries(keys),
      stillPending: key => _pending.has(key),
    };
  `, context);

  await assert.rejects(() => context.quarantineApi.flush(null), /quarantine/i);
  assert.deepEqual(drained, ['logs'], 'the healthy key drains');
  assert.equal(context.quarantineApi.stillPending('spreadsheets'), true,
    'the quarantined key stays explicitly unsynced');
});

test('MB-009: a quarantined key is reported by the per-key status model', () => {
  const context = contextWith({
    _syncReady: true,
    _syncBootstrapComplete: true,
    _syncBootstrapFailedKeys: new Set(['spreadsheets']),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    _readPendingSyncRecord: key => key === 'spreadsheets' ? { opId: 'pending-op' } : null,
    getSyncKeys: () => ['logs', 'spreadsheets'],
  });
  vm.runInContext(`
    ${declaration('_syncKeyStatus')}
    ${declaration('_unsyncedSyncKeys')}
    globalThis.statusApi = {
      status: key => _syncKeyStatus(key),
      unsynced: () => _unsyncedSyncKeys(),
    };
  `, context);

  assert.equal(context.statusApi.status('spreadsheets'), 'quarantined');
  assert.equal(context.statusApi.status('logs'), 'current');
  assert.deepEqual([...context.statusApi.unsynced()], ['spreadsheets'],
    'the badge must never read Synced while a key is quarantined');
});

// --- V159-003/009: quarantine must survive a restart --------------------------

function quarantineStoreContext(entries = {}) {
  const localStorage = new MemoryStorage(entries);
  const context = contextWith({
    localStorage,
    _syncBootstrapFailedKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    isSyncKey: key => ['logs', 'spreadsheets'].includes(key),
    getSyncKeys: () => ['logs', 'spreadsheets'],
    _readPendingSyncRecord: () => null,
  });
  vm.runInContext(`
    const SYNC_QUARANTINE_STORAGE_KEY = 'tmb_sync_quarantine_v1';
    const MAX_QUARANTINE_REASON_CHARS = 500;
    ${declaration('_loadSyncQuarantineState')}
    ${declaration('_saveSyncQuarantineState')}
    ${declaration('_quarantineSyncKey')}
    ${declaration('_clearSyncKeyQuarantine')}
    ${declaration('_restoreSyncQuarantineState')}
    ${declaration('_quarantinedSyncKeys')}
    ${declaration('_syncKeyStatus')}
    globalThis.qApi = {
      quarantine: (key, reason) => _quarantineSyncKey(key, reason),
      clear: key => _clearSyncKeyQuarantine(key),
      restore: () => _restoreSyncQuarantineState(),
      list: () => _quarantinedSyncKeys(),
      status: key => _syncKeyStatus(key),
      raw: () => localStorage.getItem(SYNC_QUARANTINE_STORAGE_KEY),
      inMemory: () => [..._syncBootstrapFailedKeys],
      forget: () => _syncBootstrapFailedKeys.clear(),
    };
  `, context);
  return context.qApi;
}

test('V159-009: quarantine is written durably, not just held in memory', () => {
  const api = quarantineStoreContext();
  api.quarantine('spreadsheets', 'workbook exceeded the sheet limit');
  const stored = JSON.parse(api.raw());
  assert.deepEqual(Object.keys(stored), ['spreadsheets']);
  assert.match(stored.spreadsheets.reason, /sheet limit/);
  assert.ok(stored.spreadsheets.at, 'records when it was quarantined');
});

test('V159-009: a restart reasserts quarantine instead of clearing it', () => {
  const api = quarantineStoreContext();
  api.quarantine('spreadsheets', 'invalid remote workbook');
  const persisted = api.raw();

  // Simulate a relaunch: fresh process, same localStorage.
  const restarted = quarantineStoreContext({ tmb_sync_quarantine_v1: persisted });
  assert.deepEqual([...restarted.inMemory()], [], 'in-memory state starts empty');
  restarted.restore();
  assert.deepEqual(restarted.list(), ['spreadsheets']);
  assert.equal(restarted.status('spreadsheets'), 'quarantined',
    'a relaunch must not silently report the key as current');
  assert.equal(restarted.status('logs'), 'current');
});

test('V159-009: reconnecting reasserts quarantine rather than dropping it', () => {
  const api = quarantineStoreContext();
  api.quarantine('spreadsheets', 'invalid remote workbook');
  // disconnectSync()/initFirebase() error paths clear the in-memory set.
  api.forget();
  assert.equal(api.status('spreadsheets'), 'current', 'in-memory only would lose it');
  api.restore();
  assert.equal(api.status('spreadsheets'), 'quarantined');
});

test('V159-009: a successful recovery clears the durable record', () => {
  const api = quarantineStoreContext();
  api.quarantine('spreadsheets', 'invalid remote workbook');
  api.clear('spreadsheets');
  assert.equal(api.raw(), null, 'the durable entry is removed');
  assert.deepEqual(api.list(), []);
  assert.equal(api.status('spreadsheets'), 'current');
});

test('V159-009: corrupt or foreign quarantine state is ignored safely', () => {
  assert.deepEqual(quarantineStoreContext({ tmb_sync_quarantine_v1: '{not json' }).list(), []);
  const foreign = quarantineStoreContext({
    tmb_sync_quarantine_v1: JSON.stringify({ not_a_sync_key: { reason: 'x', at: 'y' } }),
  });
  foreign.restore();
  assert.deepEqual(foreign.list(), [], 'unknown keys are discarded');
});

test('V159-009: quarantine reasons are bounded and never unbounded blobs', () => {
  const api = quarantineStoreContext();
  api.quarantine('logs', 'x'.repeat(5000));
  assert.equal(JSON.parse(api.raw()).logs.reason.length, 500);
});

// --- V160-001: no unsanctioned STORE.set() on a synchronized key -------------
//
// STORE.set(key, precomputedValue) is collision-unsafe for synchronized keys:
// the value is derived from a snapshot the caller read BEFORE the per-key lock,
// so a remote edit that commits meanwhile is silently overwritten. Synchronized
// keys must use STORE.mutate(key, mutator), which derives the next value from
// the reconciled base inside the lock.
//
// Every entry below is a KNOWN-UNSAFE production call site that still has to be
// converted. Shrink this list; never grow it. A new synchronized STORE.set()
// call site fails this test.

const SYNC_KEYS_REQUIRING_MUTATE = [
  'logs', 'staff_notes', 'todo_items', 'assigned_tasks', 'custom_staff',
  'staff_dir_overrides', 'removed_staff_dir', 'step_up_receipts', 'policies',
  'spreadsheets', 'room_overrides', 'room_excluded', 'room_by_instructor',
  'room_time_rules', 'flagged_emails', 'deleted_emails', 'sent_emails',
  'ms_sent_emails', 'ms_sent_conv_ids', 'comm_handled_ids', 'comm_analyzed_ids',
];

// Known-unsafe sites awaiting conversion, as `key => occurrences`.
// H-02: all sync keys were migrated to STORE.replace(); the debt is fully paid.
const STORE_SET_DEBT = {};

function storeSetCountsByKey() {
  const counts = {};
  for (const match of script.matchAll(/STORE\.set\(\s*'([a-z0-9_]+)'/gi)) {
    counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

test('V160-001: logs no longer use the collision-unsafe STORE.set path', () => {
  const counts = storeSetCountsByKey();
  assert.equal(counts.logs || 0, 0,
    'saveLogEntry/deleteLog must use STORE.mutate — this is the reproduced defect');
  assert.ok(script.includes("STORE.mutate('logs'"), 'logs use the semantic mutation path');
});

test('V160-001: synchronized STORE.set debt does not grow', () => {
  const counts = storeSetCountsByKey();
  const regressions = [];
  for (const key of SYNC_KEYS_REQUIRING_MUTATE) {
    const actual = counts[key] || 0;
    const allowed = STORE_SET_DEBT[key] || 0;
    if (actual > allowed) {
      regressions.push(`${key}: ${actual} unsafe STORE.set call(s), only ${allowed} allowed`);
    }
  }
  assert.deepEqual(regressions, [],
    'a synchronized key gained an unsafe STORE.set call site — use STORE.mutate instead');
});

test('V160-001: the debt list is accurate, so conversions must shrink it', () => {
  const counts = storeSetCountsByKey();
  const stale = [];
  for (const [key, allowed] of Object.entries(STORE_SET_DEBT)) {
    const actual = counts[key] || 0;
    if (actual < allowed) {
      stale.push(`${key}: now ${actual}, lower the allowance from ${allowed}`);
    }
  }
  assert.deepEqual(stale, [], 'converted call sites must be removed from STORE_SET_DEBT');
});

test('V160-001: record IDs are collision-resistant across devices', () => {
  assert.ok(script.includes('function _newRecordId('), '_newRecordId exists');
  const context = contextWith({ crypto: globalThis.crypto });
  vm.runInContext(`
    ${declaration('_bytesToB64')}
    ${declaration('_newRecordId')}
    globalThis.idApi = { make: () => _newRecordId() };
  `, context);
  const ids = new Set();
  for (let i = 0; i < 5000; i++) ids.add(context.idApi.make());
  assert.equal(ids.size, 5000, 'no collisions even when generated in the same millisecond');
});

// --- V160-003: poisoned-client recovery -------------------------------------
//
// A Mac that ran v1.1.59 can hold a pending record created before it ever saw
// the cloud (baseRevision 0). A legacy remote document has no `revision`, so
// syncPush's transaction also reads current = 0 and the CAS check PASSES —
// replacing the real workbook with the local default. These tests pin the hold
// that prevents that.

function recoveryStateContext(entries = {}) {
  const localStorage = new MemoryStorage(entries);
  const context = contextWith({
    localStorage,
    _syncRecoveryRequiredKeys: new Set(),
    _syncBootstrapFailedKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    isSyncKey: key => ['logs', 'spreadsheets'].includes(key),
    getSyncKeys: () => ['logs', 'spreadsheets'],
    _readPendingSyncRecord: key => key === 'spreadsheets' ? { opId: 'pending-op' } : null,
  });
  vm.runInContext(`
    const SYNC_RECOVERY_STORAGE_KEY = 'tmb_sync_recovery_v1';
    ${declaration('_loadSyncRecoveryState')}
    ${declaration('_saveSyncRecoveryState')}
    ${declaration('_markSyncRecoveryRequired')}
    ${declaration('_clearSyncRecoveryRequired')}
    ${declaration('_restoreSyncRecoveryState')}
    ${declaration('_recoveryRequiredSyncKeys')}
    ${declaration('_syncKeyStatus')}
    globalThis.recApi = {
      mark: (k, kind, rev, rk) => _markSyncRecoveryRequired(k, kind, rev, rk),
      clear: k => _clearSyncRecoveryRequired(k),
      restore: () => _restoreSyncRecoveryState(),
      held: () => _recoveryRequiredSyncKeys(),
      status: k => _syncKeyStatus(k),
      raw: () => localStorage.getItem(SYNC_RECOVERY_STORAGE_KEY),
    };
  `, context);
  return context.recApi;
}

test('V160-003: a poisoned-client hold is recorded durably', () => {
  const api = recoveryStateContext();
  api.mark('spreadsheets', 'poisoned-default', 0, 'legacy');
  const stored = JSON.parse(api.raw());
  assert.equal(stored.spreadsheets.kind, 'poisoned-default');
  assert.equal(stored.spreadsheets.remoteKind, 'legacy');
  assert.equal(api.status('spreadsheets'), 'recovery-required');
});

test('V160-003: the hold survives a restart', () => {
  const first = recoveryStateContext();
  first.mark('spreadsheets', 'poisoned-default', 0, 'legacy');
  const restarted = recoveryStateContext({ tmb_sync_recovery_v1: first.raw() });
  restarted.restore();
  assert.deepEqual(restarted.held(), ['spreadsheets']);
  assert.equal(restarted.status('spreadsheets'), 'recovery-required',
    'a relaunch must not release the hold and let the default upload');
});

test('V160-003: explicit resolution releases the hold', () => {
  const api = recoveryStateContext();
  api.mark('spreadsheets', 'poisoned-default', 0, 'legacy');
  api.clear('spreadsheets');
  assert.equal(api.raw(), null);
  assert.deepEqual(api.held(), []);
});

test('V160-003: a held key can never be scheduled for delivery', async () => {
  let drains = 0;
  const context = contextWith({
    _syncReady: true,
    _syncBootstrapComplete: true,
    _syncBootstrapFailedKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(),
    _syncRecoveryRequiredKeys: new Set(['spreadsheets']),
    _syncDeliveryChains: new Map(),
    _syncDeliveryErrors: new Map(),
    _readPendingSyncRecord: () => ({ opId: 'pending-op' }),
    getSyncKeys: () => ['spreadsheets'],
    _surfaceSyncDeliveryError: () => {},
    _drainSyncKey: async () => { drains++; return true; },
  });
  vm.runInContext(`
    ${declaration('_scheduleSyncDrain')}
    var _legacyCheckoutSweepDone = false;
    ${declaration('_isLegacyCheckoutKey')}
    ${declaration('_retireLegacyCheckoutDeliveries')}
    ${declaration('_flushSyncDeliveries')}
    globalThis.holdApi = {
      schedule: k => _scheduleSyncDrain(k),
      flush: k => _flushSyncDeliveries(k),
    };
  `, context);

  assert.equal(await context.holdApi.schedule('spreadsheets'), false);
  assert.equal(drains, 0, 'the poisoned default must never reach syncPush');
  await assert.rejects(() => context.holdApi.flush(null), /held for recovery/i,
    'flush must report the hold rather than claim success');
});

function classifyContext({ pending, remote, pendingPlaintext = null }) {
  const context = contextWith({
    _remoteDoc: remote,
    _pending: pending,
    _plaintext: pendingPlaintext,
    structuredClone,
    SYNC_ENVELOPE_FORMAT: 'mb-sync-v2',
  });
  vm.runInContext(`
    const MAX_SPREADSHEET_CELL_CHARS = 50000;
    const MAX_SPREADSHEET_SHEETS = 25;
    const MAX_SPREADSHEET_ROWS = 500;
    const MAX_SPREADSHEET_COLS = 100;
    const MAX_SPREADSHEET_GRID_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CHARS = 400000;
    const MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000;
    const SS_DEFAULT_TIMES = ['9:00', '10:00'];
    const _aesDecrypt = async () => _plaintext;
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('ssCreateDefaultSheets')}
    ${declaration('ssCreateDefaultData')}
    ${declaration('_syncDocumentKind')}
    ${declaration('_isDefaultWorkbookSnapshot')}
    ${declaration('_classifyPendingAgainstRemote')}
    globalThis.classifyApi = {
      run: key => _classifyPendingAgainstRemote(key, { exists: !!_remoteDoc, data: () => _remoteDoc }, _pending),
      isDefault: wb => _isDefaultWorkbookSnapshot(wb),
      defaultWorkbook: () => JSON.stringify(ssCreateDefaultData()),
    };
  `, context);
  return context.classifyApi;
}

const LEGACY_REMOTE = { updated: new Date().toISOString(), value: [{ id: 'real' }] };

test('V160-003: pristine default + legacy remote is classified as poisoned', async () => {
  const api = classifyContext({ pending: { baseRevision: 0, localCiphertext: 'E:x' }, remote: LEGACY_REMOTE });
  const withPlaintext = classifyContext({
    pending: { baseRevision: 0, localCiphertext: 'E:x' },
    remote: LEGACY_REMOTE,
    pendingPlaintext: api.defaultWorkbook(),
  });
  assert.equal(await withPlaintext.run('spreadsheets'), 'poisoned-default');
});

test('V160-003: any revision-0 pending against a legacy remote is held', async () => {
  const api = classifyContext({
    pending: { baseRevision: 0, localCiphertext: 'E:x' },
    remote: LEGACY_REMOTE,
    pendingPlaintext: JSON.stringify({ activeProject: 'p9', projects: [] }),
  });
  assert.equal(await api.run('spreadsheets'), 'unverified-local',
    'a legacy remote cannot be protected by CAS, so it is held either way');
});

test('V160-003: a versioned remote is left to normal CAS, not held', async () => {
  const api = classifyContext({
    pending: { baseRevision: 0, localCiphertext: 'E:x' },
    remote: {
      schemaVersion: 2, revision: 7,
      value: { format: 'mb-sync-v2', keyId: 'k', ciphertext: 'c', valueType: 'object' },
    },
  });
  assert.equal(await api.run('spreadsheets'), null,
    'expectedRevision 0 vs current 7 already raises a conflict');
});

test('V160-003: a pending record derived from an observed revision is not held', async () => {
  const api = classifyContext({ pending: { baseRevision: 4, localCiphertext: 'E:x' }, remote: LEGACY_REMOTE });
  assert.equal(await api.run('spreadsheets'), null);
});

test('V160-003: an absent remote is never held', async () => {
  const api = classifyContext({ pending: { baseRevision: 0, localCiphertext: 'E:x' }, remote: null });
  assert.equal(await api.run('spreadsheets'), null,
    'a first-ever upload to an empty studio must not be blocked');
});

test('V160-003: undecidable local ciphertext is held, not delivered', async () => {
  const api = classifyContext({
    pending: { baseRevision: 0, localCiphertext: 'E:x' },
    remote: LEGACY_REMOTE,
    pendingPlaintext: '{not valid json',
  });
  assert.equal(await api.run('spreadsheets'), 'unverified-local');
});

// --- V160-002: the fabricated default must be read-only ---------------------
//
// Not saving the default at load time was necessary but not sufficient: the user
// could still type into it, and _stageDirtySpreadsheetSave() would durably
// persist it at revision 0 — recreating the poisoned-client condition.

function authorityEditorContext(authority, { stored = null } = {}) {
  let saves = 0;
  const localStorage = new MemoryStorage();
  const context = contextWith({
    localStorage,
    _remoteAuthority: authority,
    _remoteDocPresence: new Map(),
    _syncBootstrapFailedKeys: new Set(),
    _stored: stored,
    structuredClone,
    setTimeout, clearTimeout,
    document: { getElementById: () => null },
    showToast: () => {},
    ssRender: () => {},
    _countSaves: () => saves,
    _bumpSave: () => { saves++; },
  });
  vm.runInContext(`
    const MAX_SPREADSHEET_CELL_CHARS = 50000;
    const MAX_SPREADSHEET_SHEETS = 25;
    const MAX_SPREADSHEET_ROWS = 500;
    const MAX_SPREADSHEET_COLS = 100;
    const MAX_SPREADSHEET_GRID_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CELLS = 10000;
    const MAX_SPREADSHEET_TOTAL_CHARS = 400000;
    const MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000;
    const SS_DEFAULT_TIMES = ['9:00', '10:00'];
    const STORE = { get: () => _stored };
    const _durableStoreSnapshots = new Map();
    const _cloneJson = v => JSON.parse(JSON.stringify(v));
    // _ssData, _ssBlockedWorkbook, _ssAwaitingAuthority, _ssSaveTimer,
    // _ssSavePending, _ssSaveGate, _ssDirtyWorkbook, _ssDirtyBase and
    // _ssDirtyGeneration all come from the module-level block that follows
    // normalizeSpreadsheetWorkbook in the slice above.
    // ssSave() records an attempt; _beginSpreadsheetSaveStage is not exercised.
    function ssSave() { _bumpSave(); return Promise.resolve(true); }
    function _beginSpreadsheetSaveStage() {
      const gate = { promise: Promise.resolve(), resolve: () => {}, released: false };
      _ssSaveGate = gate;
      _ssSavePending = Promise.resolve(true);
      _bumpSave();
      return gate;
    }
    function _releaseSpreadsheetSaveGate(gate) { if (gate) gate.released = true; }
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('ssCreateDefaultSheets')}
    ${declaration('ssCreateDefaultData')}
    ${declaration('_remoteStateIsAuthoritativelyAbsent')}
    // MB161-012: storage is now an index plus one document per project. These
    // harnesses drive a legacy workbook, so the mode stays 'legacy' and the
    // behaviour under test is unchanged — but the functions have to exist.
    // _ssPendingProjectIds arrives with the _ssStorageMode slice below.
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('_ssAssembleWorkbook')}
    ${declaration('_ssStorageMode')}
    ${declaration('_ssReadStoredWorkbook')}
    async function _ssMigrateToSplitStorage() { return false; }
    ${declaration('ssLoad')}
    // MB161-040: the base is now the assembled WORKBOOK, not the raw
    // 'spreadsheets' snapshot — which under split storage is the index.
    var _ssDurableWorkbook = () => (_durableStoreSnapshots.has('spreadsheets')
      ? JSON.parse(JSON.stringify(_durableStoreSnapshots.get('spreadsheets')))
      : null);
    // _stageDirtySpreadsheetSave records who staged the change (P1-01). These
    // harnesses are not about attribution, and slicing the real helper drags in
    // a neighbouring const that collides with this sandbox's own.
    if (typeof _ssAttributionActor === 'undefined') { var _ssAttributionActor = () => 'Tester'; }
    ${declaration('_stageDirtySpreadsheetSave')}
    globalThis.editorApi = {
      load: () => { ssLoad(); return _countSaves(); },
      awaiting: () => _ssAwaitingAuthority,
      // Simulate the user typing a cell, exactly as the editor does.
      type: () => {
        if (_ssData) _ssData.projects[0].sheets[0].cells['0,0'] = { v: 'typed', bg:'', tc:'', b:false };
        return _stageDirtySpreadsheetSave(0);
      },
      saves: () => _countSaves(),
    };
  `, context);
  return context.editorApi;
}

test('V160-002: typing before bootstrap cannot persist the fabricated default', async () => {
  const api = authorityEditorContext('bootstrapping');
  assert.equal(api.load(), 0, 'load itself writes nothing');
  assert.equal(api.awaiting(), true, 'the editor is held read-only');
  assert.equal(await api.type(), false, 'the edit is refused');
  assert.equal(api.saves(), 0, 'no durable revision-0 write is created');
});

test('V160-002: every unknown-authority state holds the editor', async () => {
  for (const authority of ['unknown', 'checking', 'connecting', 'authenticating',
                           'bootstrapping', 'error', 'credential-denied', 'quarantined']) {
    const api = authorityEditorContext(authority);
    api.load();
    assert.equal(api.awaiting(), true, `${authority} must hold the editor`);
    assert.equal(await api.type(), false, `${authority} must refuse edits`);
    assert.equal(api.saves(), 0, `${authority} must not write`);
  }
});

test('V160-002: an authoritatively absent remote leaves the editor writable', async () => {
  for (const authority of ['ready-absent', 'unconfigured']) {
    const api = authorityEditorContext(authority);
    assert.equal(api.load(), 1, `${authority} persists the default exactly once`);
    assert.equal(api.awaiting(), false, `${authority} must not hold the editor`);
    await api.type();
    assert.ok(api.saves() > 1, `${authority} allows subsequent edits`);
  }
});

test('V160-002: an existing local workbook is editable even when authority is unknown', async () => {
  const stored = {
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'Real', activeId: 's1',
      sheets: [{ id: 's1', name: 'Mon', rows: 2, cols: 2, colWidths: [100, 100],
                 cells: { '0,0': { v: 'real data', bg: '', tc: '', b: false } } }],
    }],
  };
  const api = authorityEditorContext('bootstrapping', { stored });
  api.load();
  assert.equal(api.awaiting(), false,
    'real local data is not a fabricated default; V160-003 protects its delivery');
  await api.type();
  assert.ok(api.saves() >= 1, 'the user can keep working on their real workbook');
});

test('V160-002: the read-only hold is released in both directions', () => {
  assert.ok(script.includes('function _reevaluateSpreadsheetAuthority('),
    'a resolution path exists');
  assert.ok(script.includes('_reevaluateSpreadsheetAuthority();'),
    'bootstrap completion calls it');
  assert.ok(script.includes('function ssWorkLocallyAnyway('),
    'the explicit user escape exists');
  // A delivered remote workbook clears the hold directly in _refreshForSyncKey,
  // and still swaps the "Checking the cloud" card for the real home view.
  assert.ok(/_ssAwaitingAuthority = false;\s*\n\s*if \(pageActive && !_ssEditCell\) \{/
    .test(script), 'an arriving remote workbook clears the hold');
  assert.ok(/if \(openProjectSurvived\) ssRender\(\);\s*\n\s*else ssGoHome\(\);/.test(script),
    'and the home card is still refreshed when no project is open');
});

test('V160-002: every editing entry point is refused while the editor is held', () => {
  assert.ok(script.includes('_ssBlockedWorkbook || _ssAwaitingAuthority || !_ssData'),
    'ssImportBuildProject and ssOpenProject are gated');
  // The chokepoint every edit funnels through.
  assert.ok(script.includes('if (!_ssData || _ssBlockedWorkbook || _ssAwaitingAuthority) return Promise.resolve(false);'),
    '_stageDirtySpreadsheetSave is the hard gate');
  const opensProject = script.slice(script.indexOf('function ssOpenProject('));
  assert.ok(opensProject.slice(0, 300).includes('_ssAwaitingAuthority'),
    'ssOpenProject cannot reach the grid editor while held');
});

// ─────────────────────────────────────────────────────────────
// NEW INVARIANTS (v1.1.60 CODEX fixes)
// ─────────────────────────────────────────────────────────────

test('H-02: STORE.set() is blocked for synchronized keys and STORE.replace() is the migration path', () => {
  // Guard must appear in set() before any other branching.
  assert.ok(
    script.includes("STORE.set() is not allowed for synchronized key"),
    'set() carries the blocking error message'
  );
  // isSyncKey guard is what triggers the block. Find the set() that contains the error.
  const errIdx = script.indexOf('STORE.set() is not allowed for synchronized key');
  const setSection = script.slice(script.lastIndexOf('set: (k, v) => {', errIdx));
  assert.ok(
    setSection.slice(0, 300).includes('isSyncKey(k)'),
    'isSyncKey guard appears near the top of set()'
  );
  // replace() is the deliberate override path for sync keys.
  // Fix 1: replace() now takes an options bag and demands an explicit
  // { authoritative } reason for synchronized keys.
  assert.ok(script.includes('replace: (k, v, options = {}) =>'), 'STORE.replace() property exists');
  assert.ok(script.includes('requires an explicit { authoritative:'),
    'and refuses an unclassified whole-value replacement');
  // persistInBackground must now route through replace() so it can write sync keys.
  assert.ok(
    script.includes('const write = STORE.replace(key, value'),
    'persistInBackground uses replace(), not set()'
  );
});

test('H-02: no synchronized key retains a STORE.set() call site', () => {
  const counts = storeSetCountsByKey();
  const regressions = [];
  for (const key of SYNC_KEYS_REQUIRING_MUTATE) {
    const actual = counts[key] || 0;
    if (actual > 0) {
      regressions.push(`${key}: ${actual} STORE.set() call(s) remain — migrate to STORE.replace()`);
    }
  }
  assert.deepEqual(regressions, [], 'all sync-key STORE.set() calls must be migrated');
});

test('H-03: offline update gate uses _unsyncedSyncKeys() in both branches', () => {
  // The old guard only checked _readPendingSyncRecord; both branches must now
  // use _unsyncedSyncKeys() so quarantined/failed/corrupt keys are caught.
  const flushSection = script.slice(script.indexOf('onFlushRequested'));
  assert.ok(
    !flushSection.slice(0, 600).includes('getSyncKeys().some(key =>'),
    'old partial pending-only check is removed from the flush gate'
  );
  // Both the sync-ready and offline paths must use the same complete model.
  const occurrences = (flushSection.slice(0, 600).match(/_unsyncedSyncKeys\(\)/g) || []).length;
  assert.ok(occurrences >= 1, 'flush gate calls _unsyncedSyncKeys()');
});

test('H-04: _createSyncConflictBackup preserves remote snapshot alongside local ciphertext', () => {
  assert.ok(
    script.includes('remoteSnapshots = null'),
    'remoteSnapshots option accepted'
  );
  assert.ok(
    script.includes('remoteRawValue: remoteSnap?.rawValue ?? null'),
    'remote raw value stored in backup entry'
  );
  assert.ok(
    script.includes('remoteRevision: remoteSnap?.revision ?? null'),
    'remote revision stored in backup entry'
  );
  // Keep This Mac must fetch the remote before creating the backup.
  const keepLocalFn = declaration('resolveSyncConflictsKeepLocal');
  assert.ok(
    keepLocalFn.includes('remoteSnapshots'),
    'resolveSyncConflictsKeepLocal passes remoteSnapshots to backup'
  );
  assert.ok(
    keepLocalFn.includes('studioRef().collection'),
    'resolveSyncConflictsKeepLocal fetches remote before backup'
  );
});

test('H-07: log entries receive a version stamp and concurrent-edit conflicts are detected', () => {
  // New entries get version:1.
  assert.ok(
    script.includes('version: 1 }'),
    'new log entries are stamped with version:1'
  );
  // The edit mutator must check the stored version against the loaded version.
  assert.ok(
    script.includes('currentVersion !== expectedVersion'),
    'version mismatch check exists in the log edit mutator'
  );
  // The conflict error message is actionable.
  assert.ok(
    script.includes('edited on another device while this form was open'),
    'conflict error tells the user to re-open the entry'
  );
  // On success, version advances.
  assert.ok(
    script.includes('version: currentVersion + 1'),
    'successful edit increments the version'
  );
  // editLog() must capture the version before the form is open.
  const editLogFn = declaration('editLog');
  assert.ok(
    editLogFn.includes('_logEditVersion'),
    'editLog captures _logEditVersion when loading the form'
  );
  // cancelLogEdit() must clear it.
  const cancelFn = declaration('cancelLogEdit');
  assert.ok(
    cancelFn.includes('_logEditVersion = null'),
    'cancelLogEdit clears _logEditVersion'
  );
});

test('H-07: deleteLog writes a tombstone so the deletion propagates across devices', () => {
  // Tombstone pattern rather than array filter.
  const deleteLogFn = declaration('deleteLog');
  assert.ok(
    deleteLogFn.includes('_deleted: true'),
    'deleteLog writes _deleted:true tombstone'
  );
  assert.ok(
    deleteLogFn.includes('_deletedAt'),
    'deleteLog stamps _deletedAt timestamp'
  );
  // The old filter-out approach must be gone from deleteLog.
  assert.ok(
    !deleteLogFn.includes('logs.filter(l => String(l.id) !== String(id))'),
    'deleteLog no longer filters the array (would lose tombstone)'
  );
  // Every human-visible read goes through getVisibleLogs(), which is the single
  // place tombstones are filtered. renderLogs must not read the raw array.
  const renderFn = declaration('renderLogs');
  assert.ok(
    renderFn.includes('getVisibleLogs()'),
    'renderLogs reads through the tombstone-filtering helper'
  );
  assert.ok(
    !renderFn.includes("STORE.get('logs'"),
    'renderLogs does not read the raw log array'
  );
  const visibleFn = declaration('getVisibleLogs');
  assert.ok(
    visibleFn.includes('_deleted'),
    'getVisibleLogs excludes tombstoned entries'
  );
});

test('H-08: _mergeSpreadsheetEdits throws an explicit conflict when a locally-changed project is deleted remotely', () => {
  const context = contextWith({});
  vm.runInContext(`
    ${declaration('_cloneJson')}
    const MAX_SPREADSHEET_CONFLICTS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssDigest')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellsOf')}
    ${declaration('_ssStampAttribution')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssConflictId')}
    var currentUser = () => 'Test Editor';
    ${declaration('_ssAttributionActor')}
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    globalThis.mergeApi = { merge: _mergeSpreadsheetEdits };
  `, context);

  const base = {
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Schedule', activeId: 's1', sheets: [] }],
  };
  // dirtyBase = same as base (what user had when they started editing).
  const dirtyBase = JSON.parse(JSON.stringify(base));
  // dirty = user changed the project name locally.
  const dirty = JSON.parse(JSON.stringify(base));
  dirty.projects[0].name = 'Changed Name';
  // Reconciled remote has deleted the project entirely.
  const reconciledBase = { activeProject: null, projects: [] };

  assert.throws(
    () => context.mergeApi.merge(reconciledBase, dirtyBase, dirty),
    /Merge conflict.*deleted on another device/,
    'structural conflict thrown when locally-changed project was remotely deleted'
  );
});

test('H-08: _mergeSpreadsheetEdits throws an explicit conflict when a locally-changed sheet is deleted remotely', () => {
  const context = contextWith({});
  vm.runInContext(`
    ${declaration('_cloneJson')}
    const MAX_SPREADSHEET_CONFLICTS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssDigest')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellsOf')}
    ${declaration('_ssStampAttribution')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssConflictId')}
    var currentUser = () => 'Test Editor';
    ${declaration('_ssAttributionActor')}
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    globalThis.mergeApi = { merge: _mergeSpreadsheetEdits };
  `, context);

  const sheet = { id: 's1', name: 'Monday', rows: 2, cols: 2, colWidths: [], cells: {} };
  const base = {
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Schedule', activeId: 's1', sheets: [sheet] }],
  };
  const dirtyBase = JSON.parse(JSON.stringify(base));
  // User renamed the sheet locally.
  const dirty = JSON.parse(JSON.stringify(base));
  dirty.projects[0].sheets[0].name = 'Monday (edited)';
  // Remote deleted the sheet.
  const reconciledBase = JSON.parse(JSON.stringify(base));
  reconciledBase.projects[0].sheets = [];

  assert.throws(
    () => context.mergeApi.merge(reconciledBase, dirtyBase, dirty),
    /Merge conflict.*deleted on another device/,
    'structural conflict thrown when locally-changed sheet was remotely deleted'
  );
});

test('H-08: _mergeSpreadsheetEdits throws when a locally-cleared cell was concurrently changed remotely', () => {
  const context = contextWith({});
  vm.runInContext(`
    ${declaration('_cloneJson')}
    const MAX_SPREADSHEET_CONFLICTS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssDigest')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellsOf')}
    ${declaration('_ssStampAttribution')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssConflictId')}
    var currentUser = () => 'Test Editor';
    ${declaration('_ssAttributionActor')}
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    globalThis.mergeApi = { merge: _mergeSpreadsheetEdits };
  `, context);

  const cell = { v: 'original', bg: '', tc: '', b: false };
  const sheet = { id: 's1', name: 'Sheet', rows: 2, cols: 2, colWidths: [], cells: { '0,0': cell } };
  const base = {
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Proj', activeId: 's1', sheets: [sheet] }],
  };
  const dirtyBase = JSON.parse(JSON.stringify(base));
  // User cleared cell 0,0 locally.
  const dirty = JSON.parse(JSON.stringify(base));
  delete dirty.projects[0].sheets[0].cells['0,0'];
  // Remote concurrently changed cell 0,0 to a different value.
  const reconciledBase = JSON.parse(JSON.stringify(base));
  reconciledBase.projects[0].sheets[0].cells['0,0'] = { v: 'remote changed', bg: '', tc: '', b: false };

  assert.throws(
    () => context.mergeApi.merge(reconciledBase, dirtyBase, dirty),
    /Merge conflict.*cleared on this Mac but changed on another device/,
    'structural conflict thrown when locally-cleared cell was concurrently modified remotely'
  );
});

test('H-09: retryQuarantinedSyncKey refreshes conflict actions after classifier failure', () => {
  // When the classifier promotes a key to recovery-required, the catch block
  // must call _updateSyncConflictActions() so the new recovery controls appear.
  const retryFn = declaration('retryQuarantinedSyncKey');
  // Find the catch block that handles classifier/reconcile failures.
  const catchBlock = retryFn.slice(retryFn.indexOf('} catch (err) {'));
  assert.ok(
    catchBlock.slice(0, 400).includes('_updateSyncConflictActions()'),
    'catch block refreshes conflict actions so recovery panel appears after classification'
  );
});

test('H-10: listener failures quarantine the key and stop its listener immediately', () => {
  // _unsubscribeSyncKey must exist.
  assert.ok(
    script.includes('function _unsubscribeSyncKey('),
    '_unsubscribeSyncKey helper exists'
  );
  // Per-key Map must be declared.
  assert.ok(
    script.includes('const _syncKeyUnsubs = new Map()'),
    '_syncKeyUnsubs per-key Map declared'
  );
  // The snapshot .catch() path (reconcile failure) must unsubscribe.
  const subscribeFn = declaration('subscribeToSync');
  // The reconcile .catch() section — search 700 chars to clear the lengthy comments.
  const catchSection = subscribeFn.slice(subscribeFn.indexOf('.catch(err => {'));
  assert.ok(
    catchSection.slice(0, 700).includes('_unsubscribeSyncKey(key)'),
    'reconcile failure unsubscribes the quarantined key'
  );
  // The Firestore listener error callback must quarantine + unsubscribe.
  const errorCbSection = subscribeFn.slice(subscribeFn.indexOf('}, err => {'));
  assert.ok(
    errorCbSection.slice(0, 600).includes('_quarantineSyncKey'),
    'listener error durably quarantines the key'
  );
  assert.ok(
    errorCbSection.slice(0, 600).includes('_unsubscribeSyncKey(key)'),
    'listener error stops the listener immediately'
  );
});

test('H-11: exportQuarantinedSyncKey requires explicit confirmation before writing plaintext to disk', () => {
  const exportFn = declaration('exportQuarantinedSyncKey');
  // The confirm gate must appear after containsPlaintext is set and before exportRecovery().
  const confirmIdx = exportFn.indexOf('window.confirm(');
  const exportIdx = exportFn.indexOf('exportRecovery(');
  assert.ok(confirmIdx >= 0, 'window.confirm() guard exists in exportQuarantinedSyncKey');
  assert.ok(exportIdx > confirmIdx, 'confirm gate precedes the actual export call');
  // The confirm message must warn about plaintext.
  assert.ok(
    exportFn.includes('UNENCRYPTED'),
    'confirm dialog uses the word UNENCRYPTED to make the risk explicit'
  );
  // Guard is conditional on containsPlaintext — encrypted exports must not be gated.
  assert.ok(
    exportFn.includes('bundle.containsPlaintext && !window.confirm('),
    'confirmation is only required when the export contains plaintext'
  );
});

// --- C-02: true two-device concurrency --------------------------------------
//
// Both devices queue a pending write from the SAME revision before either sees
// the other's change. One wins CAS; the loser must merge rather than discard.

function mergeApi() {
  const context = contextWith({
    _cloneJson: v => JSON.parse(JSON.stringify(v)),
  });
  vm.runInContext(`    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_syncMergeStrategy')}

    const SYNC_MERGE_STRATEGIES = Object.freeze({ logs: 'tombstoned-record-list' });
    ${declaration('_canAutoMergeSyncKey')}
    ${declaration('_recordSortTime')}
    ${declaration('_recordContentKey')}
    ${declaration('_ssDigest')}
    ${declaration('_conflictVariantKey')}
    ${declaration('_conflictVariantIdLegacy')}
    ${declaration('_conflictVariantId')}
    ${declaration('_conflictVariantIds')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeConflictVariants')}
    ${declaration('_mergeDivergentRecords')}
    ${declaration('_syncRecordOrderKey')}
    ${declaration('_compareSyncRecords')}
    ${declaration('_mergeTombstonedRecordLists')}
    globalThis.m = {
      merge: (a, b) => _mergeTombstonedRecordLists(a, b),
      canMerge: k => _canAutoMergeSyncKey(k),
    };
  `, context);
  return context.m;
}

const REC = (id, over = {}) => ({
  id, body: id, created: '2026-07-01T00:00:00.000Z', version: 1, ...over,
});

test('C-02: two devices adding different logs concurrently keep both', () => {
  const m = mergeApi();
  const base = [REC('base')];
  const deviceA = [...base, REC('A')];
  const deviceB = [...base, REC('B')];
  const merged = m.merge(deviceB, deviceA); // B lost CAS, rebases onto A's remote
  const ids = [...merged].map(r => r.id).sort();
  assert.deepEqual(ids, ['A', 'B', 'base'], 'neither addition is discarded');
});

test('C-02: the merge is symmetric, so both devices converge', () => {
  const m = mergeApi();
  const a = [REC('base'), REC('A')];
  const b = [REC('base'), REC('B')];
  const ab = JSON.stringify([...m.merge(a, b)].map(r => r.id).sort());
  const ba = JSON.stringify([...m.merge(b, a)].map(r => r.id).sort());
  assert.equal(ab, ba, 'merge(a,b) and merge(b,a) agree');
});

test('C-02: editing one record while another device adds a different one keeps both', () => {
  const m = mergeApi();
  const edited = [REC('base', { body: 'edited', version: 2, updated: '2026-07-02T00:00:00.000Z' })];
  const added = [REC('base'), REC('new')];
  const merged = m.merge(edited, added);
  assert.equal(merged.find(r => r.id === 'base').body, 'edited', 'the edit survives');
  assert.ok(merged.some(r => r.id === 'new'), 'the concurrent addition survives');
});

test('C-02: a concurrent edit never resurrects a deleted record', () => {
  const m = mergeApi();
  const deleted = [REC('x', { _deleted: true, _deletedAt: '2026-07-02T00:00:00.000Z' })];
  const edited = [REC('x', { body: 'edited', version: 5, updated: '2026-07-02T00:00:00.000Z' })];
  for (const merged of [m.merge(deleted, edited), m.merge(edited, deleted)]) {
    const rec = merged.find(r => r.id === 'x');
    assert.equal(rec._deleted, true, 'the deletion wins over a concurrent edit');
    assert.equal(rec.body, 'edited', 'the edit content is preserved under the tombstone');
    assert.equal(rec._supersededEdit, true, 'and is flagged as recoverable');
  }
});

test('C-02: a higher version wins for the same record', () => {
  const m = mergeApi();
  const older = [REC('x', { body: 'old', version: 1 })];
  const newer = [REC('x', { body: 'new', version: 4 })];
  assert.equal(m.merge(older, newer).find(r => r.id === 'x').body, 'new');
  assert.equal(m.merge(newer, older).find(r => r.id === 'x').body, 'new');
});

test('C-02: auto-merge is opt-in and refused for collections without tombstones', () => {
  const m = mergeApi();
  assert.equal(m.canMerge('logs'), true);
  for (const key of ['staff_notes', 'todo_items', 'assigned_tasks', 'policies',
                     'step_up_receipts', 'custom_staff', 'spreadsheets']) {
    assert.equal(m.canMerge(key), false,
      `${key} has no tombstones; union would resurrect deleted records`);
  }
});

test('C-02: merging is bounded so a CAS livelock cannot spin forever', () => {
  assert.ok(script.includes('MAX_SYNC_MERGE_ATTEMPTS'), 'a retry cap exists');
  assert.ok(script.includes('mergeAttempts < MAX_SYNC_MERGE_ATTEMPTS'),
    'the drain loop honours the cap');
  assert.ok(script.includes("err?.code === 'SYNC_CONFLICT' && _canAutoMergeSyncKey(key)"),
    'only conflicts on mergeable keys are auto-rebased');
});

test('C-02: rebase re-queues at the remote revision, not the superseded one', () => {
  const fn = script.slice(script.indexOf('async function _rebasePendingOnRemote('));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 1));
  assert.ok(body.includes('localStorage.removeItem(_pendingSyncStorageKey(key))'),
    'the stale pending record is dropped before re-queueing');
  assert.ok(body.includes('remoteRevision,'),
    'the new pending record is based on the observed remote revision');
  assert.ok(body.includes('pending.baseRevision >= remoteRevision'),
    'a rebase onto an older or equal revision is refused');
  assert.ok(body.includes('_serializeKeyMutation(key'),
    'the rebase commits inside the per-key lock');
});

// --- §3: whole-value replacement must fail closed, not lose remote edits -----

test('P0/§3: a stale STORE.replace cannot silently overwrite a remote edit', async () => {
  // Reproduces the audited sequence: remote reconciles to revision 6 while a
  // precomputed local replacement waits behind the per-key lock. Before the fix
  // the local value committed anyway AND its pending record claimed revision 6,
  // so Firebase CAS would have accepted it with no conflict.
  const localStorage = new MemoryStorage({
    tmb_logs: 'E:["base"]',
    tmb_logs_revision: '0',
  });
  const pending = {};
  let remoteStartedResolve, releaseRemote;
  const remoteStarted = new Promise(r => { remoteStartedResolve = r; });
  const gate = new Promise(r => { releaseRemote = r; });
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: Object.assign(Object.create(null), { logs: ['base'] }),
    _durableStoreSnapshots: new Map([['logs', ['base']]]),
    _cloneJson: v => JSON.parse(JSON.stringify(v)),
    _lockedStorageKeys: new Set(),
    _storeWriteChains: new Map(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _optimisticStoreValues: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    isSyncKey: k => k === 'logs',
    _newOperationId: () => 'op-local',
    _aesEncrypt: async p => 'E:' + p,
    _aesDecrypt: async c => c.slice(2),
    _normalizeSyncValue: (_k, v) => JSON.parse(JSON.stringify(v)),
    _scheduleSyncDrain: async () => false,
    _writePendingSyncRecord: (k, op, ct) => {
      pending[k] = { opId: op, localCiphertext: ct,
        baseRevision: Number(localStorage.getItem('tmb_' + k + '_revision') || 0) };
      return pending[k];
    },
    _markRemote: () => remoteStartedResolve(),
  });
  vm.runInContext(`
    ${declaration('_serializeKeyMutation')}
    ${declaration('_serializeKeyReconcile')}
    ${declaration('_localSyncRevision')}
    ${classDeclaration('SyncConflictError')}
    ${declaration('_commitEncryptedSnapshot')}
    ${declaration('_persistRemoteValue')}
    ${declaration('_digestOfValue')}
    ${declaration('_readSyncMutationBase')}
    ${declaration('_queueEncryptedWrite')}
    globalThis.api = {
      remote: g => _serializeKeyReconcile('logs', async () => {
        _markRemote(); await g;
        return _persistRemoteValue('logs', ['base', 'REMOTE'], 6);
      }),
      // Exactly what STORE.replace() does: hand a precomputed value onward.
      replaceLocal: () => _queueEncryptedWrite('logs', ['base', 'LOCAL'],
        { operationId: 'op-local' }),
      cached: () => _decCache.logs,
    };
  `, context);

  const remote = context.api.remote(gate);
  await remoteStarted;
  let conflictCode = null;
  const local = context.api.replaceLocal().catch(e => { conflictCode = e?.code; });
  await new Promise(r => setImmediate(r));
  releaseRemote();
  await Promise.all([remote, local]);

  assert.deepEqual([...context.api.cached()], ['base', 'REMOTE'],
    'the remote edit must survive a stale whole-value replacement');
  assert.equal(conflictCode, 'SYNC_CONFLICT',
    'the stale replacement raises an explicit conflict instead of committing');
});

test('P0/§3: a replacement derived from the current revision still commits', async () => {
  // The guard must not break ordinary replacement when nothing raced.
  const localStorage = new MemoryStorage({
    tmb_logs: 'E:["base"]',
    tmb_logs_revision: '3',
  });
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: Object.assign(Object.create(null), { logs: ['base'] }),
    _durableStoreSnapshots: new Map([['logs', ['base']]]),
    _cloneJson: v => JSON.parse(JSON.stringify(v)),
    _lockedStorageKeys: new Set(),
    _storeWriteChains: new Map(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _optimisticStoreValues: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    isSyncKey: k => k === 'logs',
    _newOperationId: () => 'op-local',
    _aesEncrypt: async p => 'E:' + p,
    _normalizeSyncValue: (_k, v) => JSON.parse(JSON.stringify(v)),
    _scheduleSyncDrain: async () => false,
    _writePendingSyncRecord: () => ({}),
  });
  vm.runInContext(`
    ${declaration('_serializeKeyMutation')}
    ${declaration('_localSyncRevision')}
    ${classDeclaration('SyncConflictError')}
    ${declaration('_commitEncryptedSnapshot')}
    ${declaration('_digestOfValue')}
    ${declaration('_readSyncMutationBase')}
    ${declaration('_queueEncryptedWrite')}
    globalThis.api = {
      replace: () => _queueEncryptedWrite('logs', ['base', 'LOCAL'], { operationId: 'op' }),
      cached: () => _decCache.logs,
    };
  `, context);

  await context.api.replace();
  assert.deepEqual([...context.api.cached()], ['base', 'LOCAL'],
    'an uncontended replacement is unaffected by the guard');
});

test('P0/§6: the client and Firestore rule key allowlists are identical', () => {
  // The client shipped `staff_directory` in SYNC_BASE_KEYS while firestore.rules
  // omitted it, so deploying the rules rejected every directory write.
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const clientBlock = script.slice(
    script.indexOf('const SYNC_BASE_KEYS'),
    script.indexOf(']);', script.indexOf('const SYNC_BASE_KEYS'))
  );
  const rulesBlock = rules.slice(
    rules.indexOf('function baseDataKey'),
    rules.indexOf('];', rules.indexOf('function baseDataKey'))
  );
  const names = block => [...block.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]).sort();
  const client = names(clientBlock);
  const server = names(rulesBlock);
  assert.ok(client.includes('staff_directory'), 'the client syncs staff_directory');
  assert.deepEqual(
    client.filter(k => !server.includes(k)), [],
    'every client sync key must be allowed by firestore.rules'
  );
  assert.deepEqual(
    server.filter(k => !client.includes(k)), [],
    'firestore.rules must not allow keys the client never syncs'
  );
});

// --- Fix 3: logs converge without losing a version --------------------------
//
// Two devices editing the same record from the same base both reach version 2.
// The previous merge picked one whole record by timestamp/JSON order and the
// other body vanished with no conflict.

function logMergeApi() {
  const context = contextWith({ _cloneJson: v => JSON.parse(JSON.stringify(v)) });
  vm.runInContext(`
    ${declaration('_recordSortTime')}
    ${declaration('_recordContentKey')}
    ${declaration('_ssDigest')}
    ${declaration('_conflictVariantKey')}
    ${declaration('_conflictVariantIdLegacy')}
    ${declaration('_conflictVariantId')}
    ${declaration('_conflictVariantIds')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeConflictVariants')}
    ${declaration('_mergeDivergentRecords')}
    ${declaration('_syncRecordOrderKey')}
    ${declaration('_compareSyncRecords')}
    ${declaration('_mergeTombstonedRecordLists')}
    globalThis.m = (a, b) => _mergeTombstonedRecordLists(a, b);
  `, context);
  return (a, b) => JSON.parse(JSON.stringify(context.m(a, b)));
}

const LOG_BASE = { id: 'r1', body: 'ORIG', created: '2026-08-01T09:00:00.000Z', version: 1 };
const edit = (body, at, over = {}) => [{
  ...LOG_BASE, body, updated: at, version: 2, baseVersion: 1, ...over,
}];

test('Fix 3: same log edited on two devices preserves BOTH bodies', () => {
  const merge = logMergeApi();
  const A = edit('A BODY', '2026-08-01T10:00:00.000Z');
  const B = edit('B BODY', '2026-08-01T10:00:01.000Z');
  for (const [label, result] of [['A,B', merge(A, B)], ['B,A', merge(B, A)]]) {
    const text = JSON.stringify(result);
    assert.ok(text.includes('A BODY'), `${label}: A's body survives`);
    assert.ok(text.includes('B BODY'), `${label}: B's body survives`);
    assert.ok(result[0]._conflicts?.length, `${label}: an explicit conflict is raised`);
  }
});

test('Fix 3: divergent merges converge identically on both devices', () => {
  const merge = logMergeApi();
  const A = edit('A', '2026-08-01T10:00:00.000Z');
  const B = edit('B', '2026-08-01T10:00:01.000Z');
  const C = edit('C', '2026-08-01T10:00:02.000Z');
  const s = v => JSON.stringify(v);
  assert.equal(s(merge(A, B)), s(merge(B, A)), 'commutative');
  assert.equal(s(merge(merge(A, B), C)), s(merge(A, merge(B, C))), 'associative');
  assert.equal(s(merge(merge(A, B), merge(A, B))), s(merge(A, B)), 'idempotent');
  // Every delivery order must land on the same value, or the Macs disagree.
  const orders = [merge(merge(A, B), C), merge(merge(C, A), B), merge(A, merge(B, C))];
  assert.equal(new Set(orders.map(s)).size, 1, 'all delivery orders converge');
  for (const body of ['A', 'B', 'C']) {
    assert.ok(s(orders[0]).includes(`"${body}"`), `body ${body} is recoverable`);
  }
});

test('Fix 3: a descendant edit fast-forwards instead of conflicting', () => {
  const merge = logMergeApi();
  const v2 = edit('A', '2026-08-01T10:00:00.000Z');
  const v3 = [{ ...LOG_BASE, body: 'A2', version: 3, baseVersion: 2,
    updated: '2026-08-01T11:00:00.000Z' }];
  for (const result of [merge(v2, v3), merge(v3, v2)]) {
    assert.equal(result[0].body, 'A2', 'the descendant wins');
    assert.ok(!result[0]._conflicts, 'ancestry is not a conflict');
  }
});

test('Fix 3: delete versus edit preserves both intentions', () => {
  const merge = logMergeApi();
  const del = [{ ...LOG_BASE, _deleted: true, _deletedAt: '2026-08-01T12:00:00.000Z' }];
  const ed = edit('EDITED', '2026-08-01T11:00:00.000Z');
  for (const result of [merge(del, ed), merge(ed, del)]) {
    assert.equal(result[0]._deleted, true, 'the deletion stands, nothing is resurrected');
    assert.ok(JSON.stringify(result[0]).includes('EDITED'),
      'the concurrent edit remains recoverable');
  }
});

test('Fix 3: independent records still merge without conflict', () => {
  const merge = logMergeApi();
  const A = [LOG_BASE, { id: 'r2', body: 'only-A', created: 'x', version: 1 }];
  const B = [LOG_BASE, { id: 'r3', body: 'only-B', created: 'y', version: 1 }];
  const result = merge(A, B);
  assert.deepEqual([...result].map(r => r.id).sort(), ['r1', 'r2', 'r3']);
  assert.ok(!result.some(r => r._conflicts), 'unrelated additions never conflict');
});

test('Fix 3: identical edits on both devices are not a conflict', () => {
  const merge = logMergeApi();
  const same = edit('SAME', '2026-08-01T10:00:00.000Z');
  const result = merge(same, JSON.parse(JSON.stringify(same)));
  assert.ok(!result[0]._conflicts, 'the same content from both sides is not divergent');
});

test('Fix 3: resolving a conflict supersedes every version in play', () => {
  // The resolution must outrank all conflicting versions, or the other device
  // would merge it straight back into a conflict.
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('async function resolveLogConflict('));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 1));
  assert.match(body, /Math\.max\(/, 'it takes the highest version in play');
  assert.match(body, /version: highest \+ 1/, 'and bumps past it');
  assert.match(body, /baseVersion: highest/, 'recording the base it superseded');
  assert.match(body, /delete base\._conflicts/, 'the conflict is cleared only on resolve');
  assert.match(body, /STORE\.mutate\('logs'/, 'resolution goes through the safe primitive');
});

test('Fix 3: edits record the base version they derived from', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('async function saveLogEntry('));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 1));
  assert.match(body, /baseVersion: currentVersion/,
    'without this the merge cannot tell a descendant from a rival edit');
  assert.match(body, /editedBy: _deviceId\(\)/, 'conflict metadata identifies the device');
});

test('Fix 3: conflicting versions are surfaced in the log UI', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /_renderLogConflicts\(l\)/, 'log entries render their conflicts');
  const fn = renderer.slice(renderer.indexOf('function _renderLogConflicts('));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 1));
  assert.match(body, /other version/, 'the operator is told a conflict exists');
  assert.match(body, /resolveLogConflict\(/, 'and can resolve it');
  assert.match(body, /escHtml\(variant\.body/, 'variant text is escaped, never raw');
});

// --- Fix 1: whole-value replacement must be explicitly classified ------------

function replaceGuardApi(extra = {}) {
  const context = contextWith({
    _storeWriteErrors: new Map(),
    _syncResolutionKeys: new Set(),
    _encKey: {},
    SHARED_KEYS: new Set(['firebase_studio_code']),
    SHARED: { get: () => null, set: () => true },
    isSyncKey: k => ['logs', 'todo_items'].includes(k),
    _newOperationId: () => 'op',
    _queueEncryptedWrite: (k, v, o) => Promise.resolve({ k, v, o }),
    _queueEncryptedMutation: (k, fn, o) => Promise.resolve({ k, fn, o }),
    ...extra,
  });
  vm.runInContext(`
    const STORE = { ${
      script.slice(script.indexOf('  replace: (k, v, options = {}) => {'),
        script.indexOf('\n  flush:', script.indexOf('  replace: (k, v, options = {}) => {')))
    } };
    globalThis.replace = (k, v, o) => STORE.replace(k, v, o);
  `, context);
  return context;
}

test('Fix 1: an unclassified whole-value replace on a sync key is refused', async () => {
  const api = replaceGuardApi();
  await assert.rejects(() => api.replace('logs', ['x']),
    /requires an explicit \{ authoritative/,
    'a new feature cannot silently regress to stale whole-value replacement');
  await assert.rejects(() => api.replace('logs', ['x'], { authoritative: 'ok' }),
    /requires an explicit/, 'a token reason is not accepted');
});

test('Fix 1: a classified replace is allowed through', async () => {
  const api = replaceGuardApi();
  const result = await api.replace('logs', ['x'], { authoritative: 'confirmed workbook import' });
  assert.equal(result.k, 'logs', 'an explicitly authoritative replacement proceeds');
});

test('Fix 1: non-synchronized keys are unaffected by the guard', async () => {
  const api = replaceGuardApi();
  const result = await api.replace('ui_prefs', { a: 1 });
  assert.equal(result.k, 'ui_prefs', 'local-only keys need no classification');
});

test('Fix 1: every production STORE.replace call declares its intent', () => {
  // The guard fails at runtime, but this catches an unclassified call site the
  // moment it is written rather than when a user happens to hit that path.
  const offenders = [];
  for (const line of script.split('\n')) {
    if (!line.includes('STORE.replace(')) continue;
    if (line.includes('Use STORE.mutate')) continue;   // the guard's own message
    if (line.includes('replace: (k, v, options')) continue; // the definition
    if (!line.includes('authoritative:')) offenders.push(line.trim().slice(0, 100));
  }
  assert.deepEqual(offenders, [],
    'each whole-value replacement must state why it is authoritative');
});

test('Fix 1: read-modify-write features use mutate, not replace', () => {
  // These were converted from stale whole-value replacement to semantic
  // operations applied to the reconciled base.
  for (const key of ['deleted_emails', 'comm_handled_ids', 'comm_analyzed_ids', 'staff_notes']) {
    assert.ok(script.includes(`STORE.mutate('${key}'`),
      `${key} performs a semantic mutation`);
  }
  // Set-membership must union with the base, not overwrite it.
  const analyzed = script.slice(script.indexOf("STORE.mutate('comm_analyzed_ids'"));
  assert.match(analyzed.slice(0, 400), /new Set\(Array\.isArray\(current\)/,
    'the union is taken against the reconciled base');
  // The new staff note is built once, outside the mutator.
  const notes = script.slice(script.indexOf('const note = {'));
  assert.match(notes.slice(0, 300), /_newRecordId\(\)/,
    'records get collision-resistant ids, not Date.now()');
});

// --- P1-1 / P1-6: resolution markers and Step Up access ---------------------

function conflictMergeApi() {
  const context = contextWith({ _cloneJson: v => JSON.parse(JSON.stringify(v)) });
  vm.runInContext(`
    ${declaration('_recordSortTime')}
    ${declaration('_recordContentKey')}
    ${declaration('_ssDigest')}
    ${declaration('_conflictVariantKey')}
    ${declaration('_conflictVariantIdLegacy')}
    ${declaration('_conflictVariantId')}
    ${declaration('_conflictVariantIds')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeConflictVariants')}
    ${declaration('_mergeDivergentRecords')}
    ${declaration('_syncRecordOrderKey')}
    ${declaration('_compareSyncRecords')}
    ${declaration('_mergeTombstonedRecordLists')}
    globalThis.api = {
      merge: (a, b) => _mergeTombstonedRecordLists(a, b),
      cvId: v => _conflictVariantId(v),
    };
  `, context);
  return {
    merge: (a, b) => JSON.parse(JSON.stringify(context.api.merge(a, b))),
    cvId: v => context.api.cvId(v),
  };
}

const CB = { id: 'r1', created: '2026-08-01T09:00:00.000Z' };

test('P1-1: a stale peer cannot reattach a conflict the operator resolved', () => {
  const { merge, cvId } = conflictMergeApi();
  const A = [{ ...CB, body: 'A BODY', version: 2, baseVersion: 1, updated: '2026-08-01T10:00:00.000Z' }];
  const B = [{ ...CB, body: 'B BODY', version: 2, baseVersion: 1, updated: '2026-08-01T10:00:01.000Z' }];
  const conflicted = merge(A, B);
  assert.ok(conflicted[0]._conflicts?.length, 'precondition: a conflict exists');

  // Operator resolves, recording every variant the resolution retires.
  const settled = [...conflicted[0]._conflicts.map(cvId), cvId(conflicted[0])];
  const resolved = [{ ...CB, body: 'A BODY', version: 3, baseVersion: 2,
    updated: '2026-08-01T11:00:00.000Z', _resolvedConflicts: settled }];

  // A peer that merged but never saw the resolution reconnects.
  for (const [label, out] of [
    ['resolved,stale', merge(resolved, conflicted)],
    ['stale,resolved', merge(conflicted, resolved)],
  ]) {
    assert.ok(!out[0]._conflicts?.length, `${label}: the resolved conflict does not return`);
    assert.equal(out[0].body, 'A BODY', `${label}: the resolution stands`);
    assert.ok(out[0]._resolvedConflicts?.length, `${label}: the marker propagates`);
  }
});

test('P1-1: an UNresolved variant is still preserved after a resolution', () => {
  // Resolving one conflict must not suppress a genuinely new divergence.
  const { merge, cvId } = conflictMergeApi();
  const A = [{ ...CB, body: 'A', version: 2, baseVersion: 1, updated: '2026-08-01T10:00:00.000Z' }];
  const B = [{ ...CB, body: 'B', version: 2, baseVersion: 1, updated: '2026-08-01T10:00:01.000Z' }];
  const conflicted = merge(A, B);
  const settled = [...conflicted[0]._conflicts.map(cvId), cvId(conflicted[0])];
  const resolved = [{ ...CB, body: 'A', version: 3, baseVersion: 2,
    updated: '2026-08-01T11:00:00.000Z', _resolvedConflicts: settled }];
  // A third device diverges from the resolved value.
  const fresh = [{ ...CB, body: 'C', version: 3, baseVersion: 2, updated: '2026-08-01T12:00:00.000Z' }];
  const out = merge(resolved, fresh);
  assert.ok(JSON.stringify(out).includes('"C"'), 'the new divergence is kept');
  assert.ok(out[0]._conflicts?.length, 'and raises a fresh conflict');
});

test('P1-1: resolution markers converge and stay bounded', () => {
  const { merge, cvId } = conflictMergeApi();
  const mk = (body, ids) => [{ ...CB, body, version: 3, baseVersion: 2,
    updated: '2026-08-01T11:00:00.000Z', _resolvedConflicts: ids }];
  const a = mk('X', ['cv_a', 'cv_b']);
  const b = mk('X', ['cv_b', 'cv_c']);
  const ab = merge(a, b), ba = merge(b, a);
  assert.deepEqual([...ab[0]._resolvedConflicts], ['cv_a', 'cv_b', 'cv_c'], 'union, sorted');
  assert.equal(JSON.stringify(ab), JSON.stringify(ba), 'marker merging is commutative');
  assert.ok(script.includes('MAX_RESOLVED_CONFLICT_IDS'), 'markers are bounded');
  // MB1188-017: variants are deliberately NOT capped any more — human-authored
  // text is never evicted to satisfy a limit. See the boundary tests below.
  assert.match(cvId({ id: 'r1', body: 'x' }), /^cv2_[a-z0-9]+_[a-z0-9]+$/, 'stable variant digest');
});

test('P1-1: resolveLogConflict records the variants it retires', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('async function resolveLogConflict('));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 1));
  assert.match(body, /_mergeResolvedConflictIds\(/, 'it accumulates resolution markers');
  assert.match(body, /_conflictVariantId\(/, 'identified by stable digest');
  assert.match(body, /base\._resolvedConflicts = settledIds/, 'and persists them on the record');
});

test('P1-6: Step Up is available to Owner AND Operations, not Operations alone', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('function canAccessStepUp('));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.match(body, /role === 'Owner'/, 'the owner is not locked out of her own receipts');
  assert.match(body, /role === 'Operations & Events'/, 'Operations keeps access');
  // Every Step Up gate must use it — a missed one silently denies the owner.
  for (const gate of ['requireStepUpAccess', 'getStepUpReceipts', 'saveStepUpReceipts']) {
    const g = renderer.slice(renderer.indexOf(`function ${gate}(`));
    assert.match(g.slice(0, 260), /canAccessStepUp\(\)/, `${gate} uses the shared gate`);
  }
  assert.match(renderer, /if \(page === 'stepup'\) return canAccessStepUp\(\);/, 'route gate');
  assert.match(renderer, /navStepup\.style\.display = canAccessStepUp\(\)/, 'nav gate');
  // Front Desk must still be denied.
  assert.doesNotMatch(body, /Front Desk/, 'Front Desk gains nothing');
});

// --- P0-1: spreadsheet operation model --------------------------------------
//
// The old merge diffed the local workbook against the base the editor started
// from but never asked whether the REMOTE side had changed the same target, so
// same-cell edits and delete-versus-edit silently discarded one side.

function ssOpsApi() {
  const context = contextWith({ _cloneJson: v => JSON.parse(JSON.stringify(v)) });
  vm.runInContext(`
    const MAX_SPREADSHEET_CONFLICTS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssDigest')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellsOf')}
    ${declaration('_ssStampAttribution')}
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssConflictId')}
    var currentUser = () => 'Test Editor';
    ${declaration('_ssAttributionActor')}
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    globalThis.api = {
      merge: (b, db, d) => _mergeSpreadsheetEdits(b, db, d),
      derive: (b, n) => _deriveSpreadsheetOperations(b, n),
      apply: (t, o) => _applySpreadsheetOperations(t, o),
    };
  `, context);
  return {
    merge: (b, db, d) => JSON.parse(JSON.stringify(context.api.merge(b, db, d))),
    derive: (b, n) => JSON.parse(JSON.stringify(context.api.derive(b, n))),
    apply: (t, o) => JSON.parse(JSON.stringify(context.api.apply(t, o))),
  };
}

const ssCell = v => ({ v, bg: '', tc: '', b: false });
const ssBook = (cells, sheets = ['s1']) => ({
  activeProject: 'p1',
  projects: [{
    id: 'p1', name: 'P', activeId: sheets[0],
    sheets: sheets.map(id => ({
      id, name: id.toUpperCase(), rows: 2, cols: 2, colWidths: [100, 100],
      cells: id === sheets[0] ? cells : {},
    })),
  }],
});
const ssAt = (w, k) => w.projects[0].sheets[0].cells[k]?.v;
const ssBase = ssBook({ '0,0': ssCell('BASE') });

test('P0-1: the same cell edited on both Macs preserves both values', () => {
  const { merge } = ssOpsApi();
  const remote = ssBook({ '0,0': ssCell('REMOTE EDIT') });
  const local = ssBook({ '0,0': ssCell('LOCAL EDIT') });
  const result = merge(remote, ssBase, local);
  assert.equal(result._conflicts?.length, 1, 'an explicit conflict is raised');
  const c = result._conflicts[0];
  assert.equal(c.kind, 'cell');
  assert.equal(c.base.v, 'BASE', 'the base both sides diverged from');
  assert.equal(c.local.v, 'LOCAL EDIT', "this Mac's value is preserved");
  assert.equal(c.remote.v, 'REMOTE EDIT', "the other Mac's value is preserved");
  assert.equal(c.target, '0,0', 'and the exact cell is identified');
});

test('P0-1: both Macs converge on the same current value for a cell conflict', () => {
  const { merge } = ssOpsApi();
  // Mirrored inputs: each Mac sees the other's value as the reconciled base.
  const a = merge(ssBook({ '0,0': ssCell('REMOTE') }), ssBase, ssBook({ '0,0': ssCell('LOCAL') }));
  const b = merge(ssBook({ '0,0': ssCell('LOCAL') }), ssBase, ssBook({ '0,0': ssCell('REMOTE') }));
  assert.equal(ssAt(a, '0,0'), ssAt(b, '0,0'),
    'a non-deterministic winner would leave the two Macs permanently disagreeing');
});

test('P0-1: local sheet deletion versus a remote edit preserves the edit', () => {
  const { merge } = ssOpsApi();
  const base = ssBook({}, ['s1', 's2']);
  const remote = JSON.parse(JSON.stringify(base));
  remote.projects[0].sheets[0].cells['0,0'] = ssCell('REMOTE EDIT');
  const local = JSON.parse(JSON.stringify(base));
  local.projects[0].sheets = local.projects[0].sheets.filter(s => s.id !== 's1');
  local.projects[0].activeId = 's2';

  const result = merge(remote, base, local);
  assert.deepEqual([...result.projects[0].sheets].map(s => s.id), ['s2'], 'the deletion holds');
  const c = (result._conflicts || []).find(x => x.kind === 'sheet');
  assert.ok(c, 'a sheet conflict is recorded');
  assert.ok(JSON.stringify(c.remote).includes('REMOTE EDIT'),
    'the deleted sheet — including the concurrent edit — is recoverable');
});

test('P0-1: local project deletion versus a remote edit preserves the edit', () => {
  const { merge } = ssOpsApi();
  const base = ssBook({});
  const remote = JSON.parse(JSON.stringify(base));
  remote.projects[0].sheets[0].cells['0,0'] = ssCell('REMOTE EDIT');
  const local = JSON.parse(JSON.stringify(base));
  local.projects = [];

  const result = merge(remote, base, local);
  const c = (result._conflicts || []).find(x => x.kind === 'project');
  assert.ok(c, 'a project conflict is recorded');
  assert.ok(JSON.stringify(c.remote).includes('REMOTE EDIT'),
    'the deleted project and its edit remain recoverable');
});

test('P0-1: different cells merge automatically with no conflict', () => {
  const { merge } = ssOpsApi();
  const remote = ssBook({ '0,0': ssCell('BASE'), '0,1': ssCell('B1') });
  const local = ssBook({ '0,0': ssCell('BASE'), '1,0': ssCell('A1') });
  const result = merge(remote, ssBase, local);
  assert.equal(ssAt(result, '0,1'), 'B1');
  assert.equal(ssAt(result, '1,0'), 'A1');
  assert.ok(!result._conflicts, 'independent edits must never be reported as a conflict');
});

test('P0-1: an edit onto an untouched remote applies without a false conflict', () => {
  const { merge } = ssOpsApi();
  const result = merge(JSON.parse(JSON.stringify(ssBase)), ssBase, ssBook({ '0,0': ssCell('TYPED') }));
  assert.equal(ssAt(result, '0,0'), 'TYPED');
  assert.ok(!result._conflicts);
});

test('P0-1: operation replay is idempotent', () => {
  const { merge, derive, apply } = ssOpsApi();
  const strip = w => JSON.parse(JSON.stringify(w, (k, v) => (k === 'at' ? undefined : v)));
  const remote = ssBook({ '0,0': ssCell('REMOTE') });
  const local = ssBook({ '0,0': ssCell('LOCAL') });
  const once = merge(remote, ssBase, local);
  assert.deepEqual(strip(merge(once, ssBase, local)), strip(once),
    'replaying after reconnect must not duplicate or re-conflict');

  // Applying the identical operation set twice changes nothing.
  const ops = derive(ssBase, ssBook({ '0,0': ssCell('X') }));
  const first = apply(JSON.parse(JSON.stringify(ssBase)), ops);
  const second = apply(first.workbook, ops);
  assert.deepEqual(second.workbook, first.workbook);
});

test('P0-1: operations carry the base they were derived from', () => {
  const { derive } = ssOpsApi();
  const ops = derive(ssBase, ssBook({ '0,0': ssCell('NEXT'), '1,1': ssCell('NEW') }));
  const set = ops.find(o => o.target === '0,0');
  assert.equal(set.kind, 'cell.set');
  assert.equal(set.base.v, 'BASE', 'without the base value divergence is undetectable');
  assert.equal(set.value.v, 'NEXT');
  const added = ops.find(o => o.target === '1,1');
  assert.equal(added.base, null, 'a new cell has no base');

  const cleared = derive(ssBase, ssBook({}));
  assert.equal(cleared.find(o => o.target === '0,0').kind, 'cell.clear');
});

test('P0-1: workbook conflicts survive normalization and are never evicted', () => {
  // This used to assert on the source text and passed while the runtime threw
  // every conflict away: the normalizer validated them and then returned an
  // object built from activeProject and projects alone. Preserving a losing
  // value is pointless if the next save destroys it, so this now runs the real
  // normalizer and looks at what comes out.
  const context = contextWith({ TextEncoder });
  vm.runInContext(`
    var MAX_SPREADSHEET_CELL_CHARS=50000, MAX_SPREADSHEET_SHEETS=25,
        MAX_SPREADSHEET_ROWS=500, MAX_SPREADSHEET_COLS=100,
        MAX_SPREADSHEET_GRID_CELLS=10000, MAX_SPREADSHEET_TOTAL_CELLS=10000,
        MAX_SPREADSHEET_TOTAL_CHARS=400000, MAX_SPREADSHEET_SYNC_JSON_BYTES=600000,
        MAX_RESOLVED_CONFLICT_IDS=200, MAX_SPREADSHEET_ATTRIBUTIONS=200,
        MAX_SPREADSHEET_ATTRIBUTION_NAME=80;
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    globalThis.norm = value => normalizeSpreadsheetWorkbook(value);
  `, context);

  const workbook = (conflicts) => ({
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'P', activeId: 's1', sheets: [
      { id: 's1', name: 'S', rows: 3, cols: 3, colWidths: [],
        cells: { '0,0': { v: 'x', bg: '', tc: '', b: false } } },
    ] }],
    ...(conflicts ? { _conflicts: conflicts } : {}),
  });
  const conflict = suffix => ({
    id: 'sc_' + suffix, kind: 'cell', projectId: 'p1', sheetId: 's1', target: '0,0',
    base: null, local: { v: 'mine' + suffix }, remote: { v: 'theirs' + suffix },
    at: new Date().toISOString(),
  });

  const kept = context.norm(workbook([conflict('a')]));
  assert.equal(kept._conflicts?.length, 1, 'a valid conflict survives the round trip');
  assert.equal(kept._conflicts[0].local.v, 'minea', 'with the losing value intact');

  // Normalizing its own output must be stable, because that is what repeated
  // saves actually do.
  assert.equal(context.norm(kept)._conflicts?.length, 1, 'and survives a second save');

  // MB161-009: this used to assert the list was trimmed to 200 — .slice(-200),
  // which drops the OLDEST entries. Those are the conflicts that have been
  // waiting longest, so the ones nobody has rescued were the first destroyed,
  // and a conflict record is the only surviving copy of the losing value.
  const many = context.norm(workbook(
    Array.from({ length: 260 }, (_, i) => conflict(String(i)))));
  assert.equal(many._conflicts.length, 260, 'no unresolved conflict is evicted for being one of many');
  assert.equal(many._conflicts[0].id, 'sc_0', 'and the oldest is still the first');

  // Resolution markers ARE bounded: losing one costs a second pass through the
  // same decision, not a value.
  const settled = context.norm({
    ...workbook([conflict('a')]),
    _resolvedConflicts: Array.from({ length: 260 }, (_, i) => 'sc_r' + i),
  });
  assert.equal(settled._resolvedConflicts.length, 200, 'resolution markers stay bounded');
  assert.equal(settled._conflicts.length, 1, 'without touching the conflicts');

  // Malformed metadata must never make a real workbook unloadable.
  assert.doesNotThrow(() => context.norm(workbook([{ nonsense: true }])));
  assert.equal(context.norm(workbook([{ nonsense: true }]))._conflicts, undefined);
  assert.equal(context.norm(workbook(null))._conflicts, undefined);
  assert.equal(
    context.norm({ ...workbook([conflict('a')]), _resolvedConflicts: 'nope' })._resolvedConflicts,
    undefined,
    'a malformed marker list is stripped, not thrown on');
});

// --- P0-2: per-cell attribution ---------------------------------------------
//
// "Who changed this?" is the question that actually gets asked when a schedule
// looks wrong. The stamp lives beside the cells rather than inside them: the
// merge compares cells by value, so an author folded into the cell would make
// every attribution difference look like a content edit.

const ssStamp = (w, k) => w.projects[0].sheets[0].editedBy?.[k];

test('P0-2: an edit records who made it', () => {
  const api = ssOpsApi();
  const base = ssBook({ '0,0': ssCell('old') });
  const next = ssBook({ '0,0': ssCell('new') });
  const merged = api.merge(base, base, next);
  assert.equal(ssAt(merged, '0,0'), 'new');
  assert.equal(ssStamp(merged, '0,0').by, 'Test Editor');
  assert.ok(!Number.isNaN(Date.parse(ssStamp(merged, '0,0').at)), 'and when');
});

test('P0-2: attribution never turns a clean merge into a conflict', () => {
  // The regression this design exists to prevent: two people editing different
  // cells must still merge silently even though each carries an author stamp.
  const api = ssOpsApi();
  const base = ssBook({});
  const remote = ssBook({ '0,1': ssCell('theirs') });
  remote.projects[0].sheets[0].editedBy = { '0,1': { by: 'Carrie Gass', at: '2026-08-05T14:00:00.000Z' } };
  const mine = ssBook({ '0,0': ssCell('mine') });
  const merged = api.merge(remote, base, mine);
  assert.equal(merged._conflicts, undefined, 'no conflict from bookkeeping');
  assert.equal(ssAt(merged, '0,0'), 'mine');
  assert.equal(ssAt(merged, '0,1'), 'theirs');
  assert.equal(ssStamp(merged, '0,0').by, 'Test Editor', 'my edit is mine');
  assert.equal(ssStamp(merged, '0,1').by, 'Carrie Gass', 'and theirs survives untouched');
});

test('P0-2: attribution follows the winning value in a conflict', () => {
  // Both Macs must agree on who the surviving edit belongs to, or the two
  // devices would disagree about history while agreeing about content.
  const api = ssOpsApi();
  const base = ssBook({ '0,0': ssCell('start') });
  const remote = ssBook({ '0,0': ssCell('zzz') });
  remote.projects[0].sheets[0].editedBy = { '0,0': { by: 'Carrie Gass', at: '2026-08-05T14:00:00.000Z' } };
  const mine = ssBook({ '0,0': ssCell('aaa') });
  const merged = api.merge(remote, base, mine);
  assert.ok(merged._conflicts?.length, 'the conflict is still recorded');
  // 'aaa' loses to 'zzz' under the deterministic content rule, so the stamp
  // must stay with Carrie rather than being overwritten by the loser.
  assert.equal(ssAt(merged, '0,0'), 'zzz');
  assert.equal(ssStamp(merged, '0,0').by, 'Carrie Gass');
});

test('P0-2: replaying the same operation does not rewrite history', () => {
  const api = ssOpsApi();
  const base = ssBook({ '0,0': ssCell('old') });
  const next = ssBook({ '0,0': ssCell('new') });
  const ops = api.derive(base, next);
  const once = api.apply(base, ops);
  const twice = api.apply(once.workbook, ops);
  assert.deepEqual(
    twice.workbook.projects[0].sheets[0].editedBy,
    once.workbook.projects[0].sheets[0].editedBy,
    'an idempotent replay leaves the original timestamp alone'
  );
});

test('P0-2: clearing a cell clears its stamp', () => {
  const api = ssOpsApi();
  const base = ssBook({ '0,0': ssCell('x') });
  base.projects[0].sheets[0].editedBy = { '0,0': { by: 'Carrie Gass', at: '2026-08-05T14:00:00.000Z' } };
  const next = ssBook({});
  const merged = api.merge(base, base, next);
  assert.equal(ssAt(merged, '0,0'), undefined);
  assert.equal(ssStamp(merged, '0,0'), undefined, 'no orphan stamp is left behind');
});

test('P0-2: attribution is bounded and malformed entries are dropped, not fatal', () => {
  const context = contextWith({ TextEncoder });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_normalizeSpreadsheetAttribution')}
    globalThis.norm = (s, c) => _normalizeSpreadsheetAttribution(s, c);
  `, context);
  const norm = context.norm;

  const cells = {};
  const source = {};
  for (let i = 0; i < 260; i++) {
    cells['0,' + i] = { v: 'x' };
    source['0,' + i] = { by: 'A', at: new Date(1700000000000 + i * 1000).toISOString() };
  }
  const capped = norm(source, cells);
  assert.equal(Object.keys(capped).length, 200, 'capped per sheet');
  assert.ok(capped['0,259'], 'the newest survives');
  assert.equal(capped['0,0'], undefined, 'the oldest is pruned');

  // A workbook must never become unloadable because a stamp is wrong.
  assert.equal(norm({ '0,0': { by: '', at: 'x' } }, { '0,0': {} }), null, 'blank author dropped');
  assert.equal(norm({ '0,0': { by: 'A', at: 'not-a-date' } }, { '0,0': {} }), null, 'bad date dropped');
  assert.equal(norm({ '0,0': { by: 'A', at: new Date().toISOString(), evil: 1 } }, { '0,0': {} }), null,
    'unexpected keys dropped');
  assert.equal(norm({ '9,9': { by: 'A', at: new Date().toISOString() } }, {}), null,
    'a stamp for a cell that no longer exists is not kept');
  assert.equal(norm('nonsense', {}), null);
  assert.equal(norm(null, {}), null);
});

// --- Repointing at a different Firestore project -----------------------------
//
// Revision numbers are the cloud's numbering. Aimed at a different project or
// studio document, every stored expectation describes a document that is not
// there, CAS fails closed on every key, and no retry can ever clear it —
// "expected revision 1, but cloud is revision 0" forever.

test('a cloud that authoritatively lacks a document clears the impossible revision', () => {
  const store = new Map([
    ['tmb_logs_revision', '4'],
    ['tmb_logs_pending_sync', JSON.stringify({ version: 3, opId: 'op-1234567890', baseRevision: 4, localCiphertext: 'E:x', supersededOpIds: [] })],
    ['tmb_staff_revision', '2'],
    ['tmb_policies_revision', '7'],
  ]);
  const context = contextWith({
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    getSyncKeys: () => ['logs', 'staff', 'policies'],
    _pendingSyncStorageKey: key => 'tmb_' + key + '_pending_sync',
    // logs and policies are missing from this cloud; staff is present.
    _remoteStateIsAuthoritativelyAbsent: key => key !== 'staff',
  });
  vm.runInContext(`
    ${declaration('_localSyncRevision')}
    ${declaration('_staleRevisionKeysAgainstAbsentRemote')}
    ${declaration('_resetLocalSyncRevisionsForNewCloud')}
    globalThis.api = {
      stale: () => _staleRevisionKeysAgainstAbsentRemote(),
      reset: keys => _resetLocalSyncRevisionsForNewCloud(keys),
    };
  `, context);

  // Arrays cross the vm realm boundary, so compare plain copies.
  assert.deepEqual([...context.api.stale()], ['logs', 'policies'],
    'only documents the cloud authoritatively lacks are stale');
  assert.deepEqual([...context.api.reset(context.api.stale())].sort(), ['logs', 'policies']);

  assert.equal(store.get('tmb_logs_revision'), undefined, 'the impossible expectation is gone');
  assert.equal(store.get('tmb_policies_revision'), undefined);
  assert.equal(store.get('tmb_staff_revision'), '2', 'a satisfiable expectation is untouched');

  // The local data itself is never the thing that gets reset.
  const pending = JSON.parse(store.get('tmb_logs_pending_sync'));
  assert.equal(pending.baseRevision, 0, 'the pending write becomes a create');
  assert.equal(pending.localCiphertext, 'E:x', 'the encrypted local value is preserved');
  assert.equal(pending.opId, 'op-1234567890', 'and its identity');
});

test('a failed read is never mistaken for a different cloud', () => {
  // The dangerous inverse: if a transient error could pass for absence, this
  // would reset revisions and then upload stale local data over live remote
  // data. Only authoritative absence counts.
  const store = new Map([['tmb_logs_revision', '4']]);
  const context = contextWith({
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    getSyncKeys: () => ['logs'],
    _pendingSyncStorageKey: key => 'tmb_' + key + '_pending_sync',
    _remoteStateIsAuthoritativelyAbsent: () => { throw new Error('read failed'); },
  });
  vm.runInContext(`
    ${declaration('_localSyncRevision')}
    ${declaration('_staleRevisionKeysAgainstAbsentRemote')}
    globalThis.stale = () => _staleRevisionKeysAgainstAbsentRemote();
  `, context);
  assert.deepEqual([...context.stale()], [], 'an unreadable remote resets nothing');
  assert.equal(store.get('tmb_logs_revision'), '4');
});

test('the reset runs only after bootstrap has made remote presence authoritative', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('async function initFirebase('));
  const body = fn.slice(0, fn.indexOf('\nfunction studioRef('));
  const bootstrapAt = body.indexOf('await _bootstrapSync()');
  const authorityAt = body.indexOf("_setRemoteAuthority(\n");
  const staleAt = body.indexOf('_staleRevisionKeysAgainstAbsentRemote()');
  const drainAt = body.indexOf('await _drainPendingSyncWrites()');
  assert.ok(bootstrapAt > -1 && staleAt > -1 && drainAt > -1);
  assert.ok(staleAt > bootstrapAt, 'presence is not authoritative until bootstrap completes');
  assert.ok(authorityAt === -1 || staleAt > authorityAt, 'authority is resolved first');
  assert.ok(staleAt < drainAt, 'and the reset happens before the writes it unblocks');
  assert.match(body, /SHARED\.set\('sync_cloud_binding', cloudBinding\)/,
    'the cloud this Mac synced with is recorded for the next connect');
});

test('P0-2: visiting a cell is not an edit', () => {
  // Reported from real use: Carrie was credited with changing a cell she had
  // only clicked on. Selecting can materialise an empty record where there was
  // nothing, and that was being derived as an operation and stamped.
  const api = ssOpsApi();
  const base = ssBook({});
  const touched = ssBook({ '0,3': { v: '', bg: '', tc: '', b: false } });
  assert.deepEqual([...api.derive(base, touched)], [], 'absent -> empty record is no change');
  assert.deepEqual([...api.derive(touched, base)], [], 'and neither is the reverse');

  const merged = api.merge(base, base, touched);
  assert.equal(merged.projects[0].sheets[0].editedBy, undefined, 'nobody is credited');

  // Real edits must still register, including formatting-only ones.
  assert.equal([...api.derive(base, ssBook({ '0,3': ssCell('x') }))].length, 1, 'text counts');
  assert.equal(
    [...api.derive(base, ssBook({ '0,3': { v: '', bg: '#7ed957', tc: '', b: false } }))].length, 1,
    'a fill with no text is still a real change'
  );
  assert.equal(
    [...api.derive(base, ssBook({ '0,3': { v: '', bg: '', tc: '', b: true } }))].length, 1,
    'so is bold'
  );
});

// --- MB161-009: preserved conflicts were invisible, unresolvable, and evicted -

test('MB161-009: a resolved conflict does not come back, even from a stale Mac', () => {
  const { merge } = ssOpsApi();
  const remote = ssBook({ '0,0': ssCell('REMOTE EDIT') });
  const local = ssBook({ '0,0': ssCell('LOCAL EDIT') });
  const clash = merge(remote, ssBase, local);
  assert.equal(clash._conflicts.length, 1);
  const id = clash._conflicts[0].id;

  // The operator picks a side: the value is written like any other edit, and
  // the id is recorded as settled.
  const resolved = JSON.parse(JSON.stringify(clash));
  resolved.projects[0].sheets[0].cells['0,0'] = ssCell('LOCAL EDIT');
  delete resolved._conflicts;
  resolved._resolvedConflicts = [id];
  const saved = merge(clash, clash, resolved);
  assert.equal(saved._conflicts, undefined, 'the conflict is gone');
  assert.deepEqual(saved._resolvedConflicts, [id], 'and the decision is recorded');

  // A Mac that has been offline since before the decision still carries the
  // conflict on its base. It must not be able to reattach it.
  const staleBase = JSON.parse(JSON.stringify(clash));
  staleBase._resolvedConflicts = [id];
  const afterStale = merge(staleBase, staleBase, JSON.parse(JSON.stringify(staleBase)));
  assert.equal(afterStale._conflicts, undefined, 'a settled conflict is never reattached');
});

test('MB161-009: unresolved conflicts accumulate rather than evicting each other', () => {
  const { merge } = ssOpsApi();
  // Two hundred and one distinct divergences on distinct cells. Under the old
  // .slice(-200) the first one — the oldest, longest unrescued — vanished.
  let base = ssBook({});
  const cells = {};
  for (let i = 0; i < 201; i += 1) cells[`0,${i}`] = ssCell('BASE' + i);
  base = { ...base };
  base.projects[0].sheets[0].cols = 210;
  base.projects[0].sheets[0].cells = cells;

  const remote = JSON.parse(JSON.stringify(base));
  const local = JSON.parse(JSON.stringify(base));
  for (let i = 0; i < 201; i += 1) {
    remote.projects[0].sheets[0].cells[`0,${i}`] = ssCell('THEIRS' + i);
    local.projects[0].sheets[0].cells[`0,${i}`] = ssCell('MINE' + i);
  }
  const result = merge(remote, base, local);
  assert.equal(result._conflicts.length, 201, 'every divergence is kept');
  const ids = new Set(result._conflicts.map(c => c.id));
  assert.equal(ids.size, 201, 'and each has its own id');
  // The specific record the old cap destroyed.
  assert.ok(result._conflicts.some(c => c.target === '0,0' && c.local.v === 'MINE0'),
    'including the oldest, which .slice(-200) used to drop');
});

test('MB161-009: conflict and structure digests are wide enough to trust', () => {
  const context = contextWith({ _cloneJson: v => JSON.parse(JSON.stringify(v)) });
  vm.runInContext(`
    ${declaration('_ssDigest')}
    ${declaration('_ssConflictId')}
    ${declaration('_ssStructureDigest')}
    globalThis.api = {
      digest: t => _ssDigest(t),
      id: parts => _ssConflictId(parts),
      structure: s => _ssStructureDigest(s),
    };
  `, context);

  // 64 bits, not 32: an id collision silently replaces one preserved value with
  // another, and a structure-digest collision lets a deletion swallow a remote
  // edit without recording anything at all.
  assert.equal(context.api.digest('anything').length, 13, 'fixed width');
  assert.equal(context.api.digest('a'), context.api.digest('a'), 'deterministic');
  assert.notEqual(context.api.digest('a'), context.api.digest('b'));

  // A bare join is not injective, and the parts are cell JSON full of
  // separators. These are different divergences and must get different ids.
  assert.notEqual(context.api.id(['a|b']), context.api.id(['a', 'b']));
  assert.notEqual(context.api.id(['ab', 'c']), context.api.id(['a', 'bc']));
  assert.equal(context.api.id(['a', 'b']), context.api.id(['a', 'b']));
  assert.match(context.api.id(['x']), /^sc_[0-9a-z]{13}$/);

  // Null and undefined parts must not collapse into each other's neighbours.
  assert.notEqual(context.api.id(['a', null, 'b']), context.api.id(['a', 'b', null]));

  // No collisions across a realistic population. The old 32-bit djb2 fails a
  // birthday test at this size often enough to matter.
  const seen = new Set();
  for (let i = 0; i < 20000; i += 1) {
    seen.add(context.api.id(['cell', 'p1', 's1', `0,${i}`, 'null', `{"v":"m${i}"}`, `{"v":"t${i}"}`]));
  }
  assert.equal(seen.size, 20000, 'twenty thousand distinct divergences, twenty thousand ids');

  // Attribution churn must still not read as a structural edit.
  const sheet = { id: 's1', name: 'S', cells: { '0,0': { v: 'x' } } };
  assert.equal(
    context.api.structure({ ...sheet, editedBy: { '0,0': { by: 'A' } } }),
    context.api.structure({ ...sheet, editedBy: { '0,0': { by: 'B' } } }),
    'who touched it is not what it is');
  assert.notEqual(
    context.api.structure(sheet),
    context.api.structure({ ...sheet, cells: { '0,0': { v: 'y' } } }));
});

test('MB161-009: the conflict surface exists and resolves through the edit path', () => {
  for (const name of [
    '_ssUnresolvedConflicts', 'ssRenderConflictBanner', 'ssOpenConflicts',
    'ssRenderConflictList', '_ssApplyConflictChoice', 'ssResolveConflict',
  ]) {
    assert.ok(script.includes(`function ${name}(`) || script.includes(`async function ${name}(`),
      `${name} is missing`);
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('id="ss-conflict-banner"'), 'the banner has somewhere to render');
  assert.ok(html.includes('id="ss-conflict-list"'), 'and the list does too');
  assert.match(declaration('ssRender'), /ssRenderConflictBanner\(\)/,
    'opening a project shows outstanding conflicts');

  const resolve = declaration('ssResolveConflict');
  assert.match(resolve, /_mergeResolvedConflictIds\(_ssData\._resolvedConflicts, \[id\]\)/,
    'resolving records a durable marker, not just a local deletion');
  assert.match(resolve, /await ssSave\(\)/,
    'and goes out through the ordinary save path so it merges and syncs');
  assert.match(resolve, /_ssData\.projects = priorProjects/,
    'a refused save must not leave the conflict deleted and the value gone');
});

// --- MB161-008: the dashboard's "most recent log" moved around ---------------
//
// Reported from real use: a new log appeared on both dashboards, was replaced
// by an older entry, then came back. Two causes compounded — the merge returned
// records in arrival order, and the dashboard's sort could not break a tie
// between two entries made on the same day.

test('MB161-008: merged record order is a function of the records, not arrival', () => {
  const merge = logMergeApi();
  const older = { id: 'a', date: '2026-08-05', body: 'morning', created: '2026-08-05T14:00:00.000Z', version: 1 };
  const newer = { id: 'b', date: '2026-08-05', body: 'afternoon', created: '2026-08-05T21:30:00.000Z', version: 1 };
  const third = { id: 'c', date: '2026-08-04', body: 'yesterday', created: '2026-08-04T20:00:00.000Z', version: 1 };

  const ids = list => list.map(r => r.id);
  // The Mac that just wrote `newer` holds it locally; the Mac that has not seen
  // it yet holds only the other two. Whichever way round the merge runs, and
  // whatever order either side stores its own copy in, one array must come out.
  const expected = ['b', 'a', 'c'];
  assert.deepEqual(ids(merge([newer, older, third], [older, third])), expected);
  assert.deepEqual(ids(merge([older, third], [newer, older, third])), expected);
  assert.deepEqual(ids(merge([third, older], [third, newer])), expected);
  assert.deepEqual(ids(merge([newer], [third, older])), expected);
});

test('MB161-008: a same-day tie is broken by creation time, not array position', () => {
  const context = contextWith({});
  vm.runInContext(`
    ${declaration('_syncRecordOrderKey')}
    ${declaration('_compareSyncRecords')}
    globalThis.newest = list => list.slice().sort(_compareSyncRecords)[0];
  `, context);

  const morning = { id: 'zzz', date: '2026-08-05', created: '2026-08-05T14:00:00.000Z' };
  const evening = { id: 'aaa', date: '2026-08-05', created: '2026-08-05T21:30:00.000Z' };

  // Same date, so `date` alone ties and a stable sort returns whichever came
  // first — which is exactly what the dashboard was doing.
  assert.equal(context.newest([morning, evening]).id, 'aaa');
  assert.equal(context.newest([evening, morning]).id, 'aaa');
  // And the id must not be trusted as a clock: record ids are random by design.
  assert.equal(context.newest([evening, morning]).created, '2026-08-05T21:30:00.000Z',
    'the later entry wins even though its id sorts lower');

  // A dated record always outranks one with no date at all.
  assert.equal(context.newest([{ id: 'x' }, morning]).id, 'zzz');
});

test('MB161-008: the renderers and the local save share one comparator', () => {
  assert.match(declaration('saveLogEntry'), /logs\.sort\(_compareSyncRecords\)/,
    'a local save must store the same order the merge produces');
  assert.match(declaration('renderYesterdayLog'), /sort\(_compareSyncRecords\)/,
    'the dashboard must not depend on array position');
  assert.match(declaration('renderLogs'), /sort\(_compareSyncRecords\)/,
    'nor the log page');
});

// --- Lesson check-out, retired with MindBody ---------------------------------

test('queued check-out deliveries are retired instead of retried forever', () => {
  // Nothing writes checkout_<date> any more, so nothing will ever drain what a
  // Mac had queued when it upgraded. Left alone those records sit behind the
  // sync status permanently. The encrypted day records are a different matter:
  // they are the studio's data and removing a feature is not licence to delete
  // them.
  const store = new Map([
    ['tmb_checkout_2026-06-18_pending_sync', JSON.stringify({ version: 3, opId: 'op-1234567890', baseRevision: 0, localCiphertext: 'E:old', supersededOpIds: [] })],
    ['tmb_checkout_2026-06-18_pending_op', 'op-1234567890'],
    ['tmb_checkout_2026-06-18_revision', '4'],
    ['tmb_checkout_2026-06-18', 'E:old'],
    ['tmb_checkout_2026-08-05_pending_sync', JSON.stringify({ version: 3, opId: 'op-0987654321', baseRevision: 0, localCiphertext: 'E:today', supersededOpIds: [] })],
    ['tmb_checkout_2026-08-05', 'E:today'],
    ['tmb_logs_pending_sync', JSON.stringify({ version: 3, opId: 'op-1111111111', baseRevision: 0, localCiphertext: 'E:logs', supersededOpIds: [] })],
    ['tmb_checkout_2026-02-30_pending_sync', 'E:not-a-real-date'],
  ]);
  const errors = new Map([
    ['checkout_2026-06-18', new Error('Missing or insufficient permissions.')],
    ['checkout_2026-07-04', new Error('Missing or insufficient permissions.')],
    ['logs', new Error('unrelated')],
  ]);
  const context = contextWith({
    localStorage: Object.create(null, {
      removeItem: { value: k => store.delete(k), enumerable: false },
      getItem: { value: k => (store.has(k) ? store.get(k) : null), enumerable: false },
    }),
    _syncDeliveryErrors: errors,
    _todayLocal: (d = new Date('2026-08-05T12:00:00')) =>
      new Date(d).toISOString().slice(0, 10),
  });
  // Object.keys(localStorage) is how the sweep enumerates real browser storage;
  // the fake above mirrors that by exposing the stored names as own keys.
  for (const name of store.keys()) context.localStorage[name] = store.get(name);

  vm.runInContext(`
    var _legacyCheckoutSweepDone = false;
    ${declaration('_isLegacyCheckoutKey')}
    ${declaration('_retireLegacyCheckoutDeliveries')}
    globalThis.api = { sweep: () => _retireLegacyCheckoutDeliveries() };
  `, context);

  const retired = context.api.sweep();
  assert.deepEqual([...retired],
    ['checkout_2026-06-18', 'checkout_2026-07-04', 'checkout_2026-08-05'],
    'every queued day is retired, including one known only from its error');

  for (const suffix of ['_pending_sync', '_pending_op', '_revision']) {
    assert.equal(store.get('tmb_checkout_2026-06-18' + suffix), undefined,
      `no more doomed retries for ${suffix}`);
  }
  assert.equal(store.get('tmb_checkout_2026-08-05_pending_sync'), undefined,
    'today is no more deliverable than any other day now');

  assert.equal(store.get('tmb_checkout_2026-06-18'), 'E:old',
    'the encrypted day record is the studio\'s data and stays');
  assert.equal(store.get('tmb_checkout_2026-08-05'), 'E:today');

  assert.equal(store.get('tmb_checkout_2026-02-30_pending_sync'), 'E:not-a-real-date',
    'a date-shaped name that is not a real date is not ours to delete');
  assert.equal(store.get('tmb_logs_pending_sync') !== undefined, true,
    'and an unrelated key is untouched');

  assert.equal(errors.has('checkout_2026-06-18'), false, 'it stops reporting as an error');
  assert.equal(errors.has('checkout_2026-07-04'), false);
  assert.equal(errors.has('logs'), true, 'without swallowing a real one');

  assert.deepEqual([...context.api.sweep()], [], 'the sweep runs once per session');
});

test('nothing in the client or the rules still writes a date-shaped key', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  assert.doesNotMatch(renderer, /getSyncKeys\(\)[\s\S]{0,200}?'checkout_'/,
    'getSyncKeys must not synthesise a checkout key');
  assert.doesNotMatch(stripRulesComments(rules), /checkout_/,
    'and the rules must not admit one');
});

// --- Two Macs editing the same sheet at the same moment ----------------------
//
// Reported from real use: simultaneous edits produced a sync conflict and the
// losing Mac stopped delivering entirely. spreadsheets had no merge strategy,
// so a CAS collision froze the key until someone chose Use Cloud or Keep This
// Mac — a whole-workbook choice that necessarily discards one person's work.

function ssRebaseApi() {
  const context = contextWith({ _cloneJson: v => JSON.parse(JSON.stringify(v)) });
  vm.runInContext(`    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_syncMergeStrategy')}

    const MAX_SPREADSHEET_CONFLICTS = 200;
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    var currentUser = () => 'Test Editor';
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssDigest')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellsOf')}
    ${declaration('_ssStampAttribution')}
    ${declaration('_ssConflictId')}
    ${declaration('_ssAttributionActor')}
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    ${declaration('_syncRecordOrderKey')}
    ${declaration('_compareSyncRecords')}
    ${declaration('_mergeTombstonedRecordLists')}
    ${script.slice(script.indexOf('class SyncRebaseUndecidable'), script.indexOf('function _mergeSyncValuesForKey'))}
    var SYNC_MERGE_STRATEGIES = { logs: 'tombstoned-record-list', spreadsheets: 'spreadsheet-operations' };
    ${declaration('_canAutoMergeSyncKey')}
    ${declaration('_mergeSyncValuesForKey')}
    globalThis.api = {
      merge: (key, parts) => _mergeSyncValuesForKey(key, parts),
      canMerge: key => _canAutoMergeSyncKey(key),
    };
  `, context);
  return context.api;
}

test('two Macs editing different cells at once merge without asking anyone', () => {
  const api = ssRebaseApi();
  assert.equal(api.canMerge('spreadsheets'), true, 'spreadsheets is mergeable at all');

  const base = ssBook({ '0,0': ssCell('start') });
  // The other Mac won the race and its edit is what the cloud now holds.
  const remote = ssBook({ '0,0': ssCell('start'), '0,1': ssCell('theirs') });
  // This Mac edited a different cell from the same starting point.
  const local = ssBook({ '0,0': ssCell('start'), '1,0': ssCell('mine') });

  const merged = JSON.parse(JSON.stringify(
    api.merge('spreadsheets', { localValue: local, remoteValue: remote, baseValue: base })));
  assert.equal(ssAt(merged, '0,1'), 'theirs', 'the winner keeps their edit');
  assert.equal(ssAt(merged, '1,0'), 'mine', 'and the loser is not discarded');
  assert.equal(merged._conflicts, undefined, 'nobody is asked to choose');
});

test('the same cell edited on both Macs keeps both versions on record', () => {
  const api = ssRebaseApi();
  const base = ssBook({ '0,0': ssCell('start') });
  const remote = ssBook({ '0,0': ssCell('zzz theirs') });
  const local = ssBook({ '0,0': ssCell('aaa mine') });
  const merged = JSON.parse(JSON.stringify(
    api.merge('spreadsheets', { localValue: local, remoteValue: remote, baseValue: base })));
  assert.ok(merged._conflicts?.length, 'a real collision is recorded, not silently resolved');
  const conflict = merged._conflicts[0];
  assert.equal(conflict.local.v, 'aaa mine', 'the losing text is preserved');
  assert.equal(conflict.remote.v, 'zzz theirs', 'and so is the winning one');
  assert.equal(ssAt(merged, '0,0'), 'zzz theirs',
    'both Macs settle on the same survivor, so they converge');
});

test('a delete-versus-edit collision stops and asks instead of merging', () => {
  const api = ssRebaseApi();
  // H-08: cleared here, changed there. A clear has no value to keep, so
  // resolving it either way destroys something.
  const base = ssBook({ '0,0': ssCell('start') });
  const remote = ssBook({ '0,0': ssCell('their change') });
  const local = ssBook({});
  assert.throws(
    () => api.merge('spreadsheets', { localValue: local, remoteValue: remote, baseValue: base }),
    error => error.code === 'SYNC_REBASE_UNDECIDABLE' && /cleared on this Mac/.test(error.message),
    'it escalates as undecidable rather than throwing a generic failure'
  );
});

test('a pending edit with no recorded base refuses rather than guessing', () => {
  // Written by an older build, or after storage was trimmed. Without the
  // starting point there is no way to tell this Mac's edits from the other
  // Mac's, and guessing would silently revert whoever lost the race.
  const api = ssRebaseApi();
  assert.throws(
    () => api.merge('spreadsheets', {
      localValue: ssBook({ '0,0': ssCell('mine') }),
      remoteValue: ssBook({ '0,0': ssCell('theirs') }),
      baseValue: null,
    }),
    error => error.code === 'SYNC_REBASE_UNDECIDABLE' && /what it started from/.test(error.message)
  );
});

test('the merge base travels with the pending write and survives more typing', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // The base belongs to the whole undelivered run. Taking the newest local
  // value would derive an empty operation set and rebase to a no-op.
  assert.match(renderer, /\.\.\.\(previous\?\.baseCiphertext\s*\n?\s*\? \{ baseCiphertext: previous\.baseCiphertext \}/);
  // The value being overwritten is the base — read before the overwrite.
  assert.match(renderer, /_writePendingSyncRecord\(k, operationId, enc, mergeBaseCiphertext \|\| prior\.ciphertext\)/);
  // A second rebase must diff against what it merged onto, not the pre-merge
  // local value, or this Mac's edits get replayed twice.
  assert.match(renderer, /const rebasedBase = _needsMergeBase\(key\)\s*\n\s*\? await _aesEncrypt\(JSON\.stringify\(remoteValue\)\)/);
  // Only carried where a strategy reads it; it is a second full encrypted copy.
  // MB161-012: project keys are dynamic, so the strategy is resolved by a
  // function rather than a plain lookup. The property that matters is unchanged:
  // only the operation merge needs a recorded base.
  assert.match(renderer, /function _needsMergeBase\(key\) \{\s*\n\s*return _syncMergeStrategy\(key\) === 'spreadsheet-operations';/);
  assert.match(renderer, /function _syncMergeStrategy\(key\) \{[\s\S]*?if \(_ssIsProjectSyncKey\(key\)\) return 'spreadsheet-operations';/);
  // Older records lack the field entirely and must stay readable.
  assert.match(renderer, /record\.baseCiphertext !== undefined && record\.baseCiphertext !== null &&/);
  // And the retry stays bounded.
  assert.match(renderer, /mergeAttempts < MAX_SYNC_MERGE_ATTEMPTS/);
});

// --- MB161-003/004: structural operations -----------------------------------
//
// External audit reproduced these against the packaged app: two Macs renaming
// the same project ended up with different names permanently, ordinary
// deletions manufactured conflicts, and a second divergence on one cell was
// dropped as a duplicate of the first.

const ssNamed = (pname, sname, cells = {}) => ({
  activeProject: 'p1',
  projects: [{ id: 'p1', name: pname, activeId: 's1', sheets: [
    { id: 's1', name: sname, rows: 3, cols: 3, colWidths: [], cells },
  ] }],
});

test('MB161-003: two Macs renaming the same project converge and record it', () => {
  const api = ssOpsApi();
  const base = ssNamed('Original', 'Sheet1');
  const alpha = ssNamed('Alpha', 'Sheet1');
  const beta = ssNamed('Beta', 'Sheet1');
  // Each Mac merges the other's value onto the same common base.
  const onB = api.merge(alpha, base, beta);
  const onA = api.merge(beta, base, alpha);
  assert.equal(onB.projects[0].name, onA.projects[0].name,
    'both Macs settle on the same name rather than each keeping its own');
  assert.ok(onB._conflicts?.length, 'and the disagreement is recorded, not silent');
  assert.equal(onB._conflicts[0].kind, 'project-name');
  assert.equal(onB._conflicts[0].base, 'Original');
  assert.ok([onB._conflicts[0].local, onB._conflicts[0].remote].includes('Alpha'));
  assert.ok([onB._conflicts[0].local, onB._conflicts[0].remote].includes('Beta'));
});

test('MB161-003: sheet renames converge the same way', () => {
  const api = ssOpsApi();
  const base = ssNamed('P', 'Base');
  const a = ssNamed('P', 'NameA');
  const b = ssNamed('P', 'NameB');
  assert.equal(
    api.merge(a, base, b).projects[0].sheets[0].name,
    api.merge(b, base, a).projects[0].sheets[0].name,
  );
});

test('MB161-003: an uncontested rename still applies without a conflict', () => {
  const api = ssOpsApi();
  const base = ssNamed('Original', 'Sheet1');
  const renamed = ssNamed('Renamed', 'Sheet1');
  const merged = api.merge(base, base, renamed);
  assert.equal(merged.projects[0].name, 'Renamed', 'a solo rename is not obstructed');
  assert.equal(merged._conflicts, undefined, 'and nobody is asked to resolve it');
});

test('MB161-004: an uncontested deletion is not a conflict', () => {
  const api = ssOpsApi();
  const withBoth = () => ({ activeProject: 'p1', projects: [{ id: 'p1', name: 'P', activeId: 's1', sheets: [
    { id: 's1', name: 'S1', rows: 3, cols: 3, colWidths: [], cells: {} },
    { id: 's2', name: 'S2', rows: 3, cols: 3, colWidths: [], cells: {} },
  ] }] });
  const withOne = () => ({ activeProject: 'p1', projects: [{ id: 'p1', name: 'P', activeId: 's1', sheets: [
    { id: 's1', name: 'S1', rows: 3, cols: 3, colWidths: [], cells: {} },
  ] }] });
  const merged = api.merge(withBoth(), withBoth(), withOne());
  assert.equal(merged._conflicts, undefined,
    'routine cleanup does not present itself as a problem to resolve');
  assert.equal(merged.projects[0].sheets.length, 1);

  // But a deletion that raced a remote edit still preserves the remote copy.
  const remoteEdited = withBoth();
  remoteEdited.projects[0].sheets[1].cells['0,0'] = { v: 'theirs', bg: '', tc: '', b: false };
  const contested = api.merge(remoteEdited, withBoth(), withOne());
  assert.ok(contested._conflicts?.length, 'a contested deletion is still recorded');
  assert.equal(contested._conflicts[0].remote.cells['0,0'].v, 'theirs',
    'and carries the copy that would otherwise be destroyed');
});

test('MB161-004: a second divergence on one cell does not erase the first', () => {
  const api = ssOpsApi();
  const cell = v => ssNamed('P', 'S', { '0,0': ssCell(v) });
  const first = api.merge(cell('remote1'), cell('base1'), cell('local1'));
  const second = api.merge(cell('remote2'), cell('base2'), cell('local2'));
  assert.notEqual(first._conflicts[0].id, second._conflicts[0].id,
    'the id names the divergence, not merely where it happened');
});

test('MB161-007: projects and sheets do not mint ids from the clock alone', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(renderer, /'proj_' \+ Date\.now\(\)/);
  assert.doesNotMatch(renderer, /'sheet_' \+ Date\.now\(\)/);
  assert.match(renderer, /'proj_' \+ _newRecordId\(\)/);
  assert.match(renderer, /'sheet_' \+ _newRecordId\(\)/);
});

test('MB161-003: the local name is no longer copied over the merged result', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('function _mergeSpreadsheetEdits('));
  const body = fn.slice(0, fn.indexOf('\nfunction ', 1));
  assert.doesNotMatch(body, /if \(local\.name !== origin2\.name\) project\.name = local\.name;/);
  assert.doesNotMatch(body, /if \(sheet\.name !== originSheet\.name\) target\.name = sheet\.name;/);
  // Dimensions are not operations yet and must still be carried.
  assert.match(body, /if \(sheet\.rows !== originSheet\.rows\) target\.rows = sheet\.rows;/);
});

test('clearing a fill does not make the workbook unsaveable', () => {
  // Reported from real use: "Spreadsheet changes were not saved: spreadsheets
  // has an invalid cell background", after which the project closed. The
  // no-fill button wrote bg: null, and the validator accepted undefined and ''
  // but threw on null — so one click poisoned every later save, and the
  // save-failure path then dropped the operator back to the project list.
  const context = contextWith({ TextEncoder });
  vm.runInContext(`
    var MAX_SPREADSHEET_CELL_CHARS=50000, MAX_SPREADSHEET_SHEETS=25,
        MAX_SPREADSHEET_ROWS=500, MAX_SPREADSHEET_COLS=100,
        MAX_SPREADSHEET_GRID_CELLS=10000, MAX_SPREADSHEET_TOTAL_CELLS=10000,
        MAX_SPREADSHEET_TOTAL_CHARS=400000, MAX_SPREADSHEET_SYNC_JSON_BYTES=600000,
        MAX_SPREADSHEET_CONFLICTS=200, MAX_SPREADSHEET_ATTRIBUTIONS=200,
        MAX_SPREADSHEET_ATTRIBUTION_NAME=80;
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    globalThis.norm = v => normalizeSpreadsheetWorkbook(v);
  `, context);

  const withCell = cell => ({ activeProject: 'p1', projects: [{ id: 'p1', name: 'P',
    activeId: 's1', sheets: [{ id: 's1', name: 'S', rows: 3, cols: 3, colWidths: [],
      cells: { '0,0': cell } }] }] });

  // The exact shape the no-fill button produced.
  const poisoned = withCell({ v: 'keep me', bg: null, tc: null, b: false });
  assert.doesNotThrow(() => context.norm(poisoned),
    'a colour must never cost the operator their unsaved work');
  const healed = context.norm(poisoned);
  assert.equal(healed.projects[0].sheets[0].cells['0,0'].v, 'keep me',
    'and the text survives the repair');
  assert.equal(healed.projects[0].sheets[0].cells['0,0'].bg, '');

  // Other unusable shapes are coerced rather than thrown, including workbooks
  // already carrying them on disk from before the fix.
  for (const bad of [null, 0, {}, [], 'x'.repeat(64)]) {
    assert.doesNotThrow(() => context.norm(withCell({ v: 'a', bg: bad, tc: bad, b: false })));
  }
  // A real colour is still preserved exactly.
  assert.equal(
    context.norm(withCell({ v: 'a', bg: '#7ed957', tc: '#333333', b: false }))
      .projects[0].sheets[0].cells['0,0'].bg,
    '#7ed957');

  // And the source of the nulls is closed.
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /function ssClearColor\(\) \{ ssApplyBg\('',''\); \}/);
  assert.match(renderer, /function ssApplyCustomColor\(bg\) \{ ssApplyBg\(bg,''\); \}/);
  assert.doesNotMatch(renderer, /ssApplyBg\(null,null\)/);

  // Content is still allowed to refuse: this guard is for decoration only.
  assert.throws(() => context.norm(withCell({ v: {}, bg: '', tc: '', b: false })),
    /non-text cell value/);
});

test('MB161-036: nothing in sync assumes exactly two Macs', () => {
  // The design is per-key compare-and-swap with rebase-on-conflict, not a
  // two-way diff, so it converges for any number of writers. This pins the
  // parts that would quietly cap it at two if somebody changed them.

  // 1. Writes are bound to the revision they were derived from, and a losing
  //    writer rebases onto what it just observed rather than giving up or
  //    overwriting. That is what makes a third and fourth writer safe.
  assert.ok(script.includes('if (current !== expectedRevision && !recognizedSupersededWrite && !explicitlyKeepLocal)'),
    'a write that lost the race is refused rather than clobbering');
  assert.ok(script.includes('throw new SyncConflictError(key, expectedRevision, current)'));
  assert.ok(script.includes('expectedRevision: pending.baseRevision'),
    'and the retry carries a base, so it can be rebased instead of re-sent blind');

  // 2. The writer is identified per device, not per "other Mac".
  assert.ok(script.includes('writer: _deviceId()'));

  // 3. Presence has room for more than two, and a colour for each.
  const peers = script.match(/SS_PRESENCE_MAX_PEERS = (\d+)/);
  assert.ok(peers && Number(peers[1]) >= 4, 'presence holds at least four peers');
  const colours = script.match(/SS_PRESENCE_COLORS = \[([\s\S]*?)\]/);
  assert.ok((colours[1].match(/#/g) || []).length >= 4,
    'and enough distinct colours that two Macs are not shown as one');

  // 4. Conflicts accumulate rather than being capped at a pair. More writers
  //    means more collisions, and losing one silently is the thing that must
  //    not happen.
  assert.ok(!/\.slice\(-MAX_SPREADSHEET_CONFLICTS\)/.test(script),
    'unresolved conflicts are never evicted to make room');

  // 5. Per-project documents are what keep four Macs out of each other's way:
  //    two people editing different projects never touch the same document.
  assert.ok(script.includes('_ssProjectSyncKey'));
});

test('MB161-047: awaiting a key lock you already hold never returns', async () => {
  // The claim behind the fix, demonstrated with the real function rather than
  // reasoned about — the failure was invisible: no error, no rejection, just a
  // promise that never settles and a save queue that never moves again.
  //
  // Note the precise shape. Re-entering is only fatal when the outer task
  // AWAITS the inner one, which is what the real code did. My first attempt at
  // this test did not await, so the inner call simply ran after the outer
  // finished and the test reported no deadlock at all.
  const context = vm.createContext({ Promise, Map, Set, setTimeout });
  vm.runInContext(`
    var _keyMutationChains = new Map();
    ${declaration('_serializeKeyMutation')}
    globalThis.serialize = (key, task) => _serializeKeyMutation(key, task);
  `, context);

  const raced = async (promise, ms) => {
    let timedOut = false;
    await Promise.race([
      promise.then(() => {}, () => {}),
      new Promise(resolve => setTimeout(() => { timedOut = true; resolve(); }, ms)),
    ]);
    return timedOut;
  };

  // A DIFFERENT key from inside: completes normally. This is the pattern the
  // per-project document writes use, and it has to keep working.
  let otherKeyRan = false;
  const differentKey = context.serialize('spreadsheets', async () => {
    await context.serialize('spreadsheet_proj_1', async () => { otherKeyRan = true; });
  });
  assert.equal(await raced(differentKey, 100), false, 'a different key does not block');
  assert.equal(otherKeyRan, true);

  // The SAME key, awaited from inside: never settles.
  let sameKeyRan = false;
  const sameKey = context.serialize('logs', async () => {
    await context.serialize('logs', async () => { sameKeyRan = true; });
  });
  assert.equal(await raced(sameKey, 150), true,
    'awaiting a lock this task already holds waits on itself, forever');
  assert.equal(sameKeyRan, false, 'and the inner task never runs');
});

test('MB1188-003: a project saved during migration survives it', async () => {
  // The failure this reproduces: migration read the legacy workbook OUTSIDE any
  // lock, then wrote documents and an index derived from that snapshot. A
  // project created while those writes were in flight saved normally — and was
  // erased seconds later when the stale index landed on top of it. The operator
  // saw a successful save, then watched the project vanish.
  //
  // This drives the real _ssMigrateToSplitStorage and the real
  // _serializeKeyMutation. Nothing here asserts on source text.
  const commits = [];
  const durable = new Map();
  let releaseFirstDocument;
  const heldAtFirstDocument = new Promise(resolve => { releaseFirstDocument = resolve; });
  let documentsSeen = 0;

  const context = vm.createContext({
    Promise, Map, Set, Array, Object, JSON, Number, String, Boolean, Date, setTimeout, TextEncoder,
    console: { warn() {}, error() {}, info() {}, log() {} },
    showToast() {},
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    heldAtFirstDocument,
    onDocument: () => { documentsSeen += 1; },
    record: (key, value) => commits.push({ key, value: JSON.parse(JSON.stringify(value)) }),
  });

  vm.runInContext(`
    var _keyMutationChains = new Map();
    var SPREADSHEET_INDEX_SCHEMA = 2;
    var SPREADSHEET_PROJECT_KEY_PREFIX = 'spreadsheet_';
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    var MAX_SPREADSHEET_TOMBSTONES = 175;
    var MAX_SPREADSHEET_INDEX_RECORDS = 400;
    var MAX_SPREADSHEET_INDEX_BYTES = 64000;
    var MAX_SPREADSHEET_PROJECTS = 25;
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80,
        MAX_RESOLVED_CONFLICT_IDS = 200, MAX_SPREADSHEET_CONFLICTS = 200;
    // _ssAwaitingAuthority and _ssBlockedWorkbook are NOT declared here: they
    // arrive as top-level \`let\`s inside the normalizeSpreadsheetWorkbook
    // slice, and both already initialise falsy.
    var _syncReady = false, _syncBootstrapComplete = false;
    var _durableStoreSnapshots = new Map();
    var _ssMigrationRan = false, _ssMigrationInFlight = null;
    var _newOperationId = () => 'op';

    // The store the app reads through. Writing here is what "durable" means.
    var _stored = new Map();
    var STORE = { get: (key, fallback) => _stored.has(key) ? _stored.get(key) : fallback };

    // Stands in for the encrypted write. It holds the FIRST project document
    // open, which is exactly where the original race was reproduced.
    async function _commitEncryptedSnapshot(key, serialized, normalized) {
      if (key !== 'spreadsheets') {
        onDocument();
        await heldAtFirstDocument;
      }
      _stored.set(key, normalized);
      _durableStoreSnapshots.set(key, normalized);
      record(key, normalized);
    }

    ${declaration('_serializeKeyMutation')}
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_ssStorageMode')}
    ${declaration('_ssProjectAsDoc')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssSplitWorkbook')}
    ${declaration('_ssMigrateToSplitStorage')}

    // Seed one legacy project, the way a pre-split Mac has it on disk.
    var legacy = normalizeSpreadsheetWorkbook({
      activeProject: 'old',
      projects: [{ id: 'old', name: 'Existing', activeId: 's1',
                   sheets: [{ id: 's1', name: 'Sheet1', rows: 5, cols: 5,
                              colWidths: [100, 100, 100, 100, 100], cells: {} }] }],
    });
    _stored.set('spreadsheets', legacy);
    _durableStoreSnapshots.set('spreadsheets', legacy);

    globalThis.migrate = () => _ssMigrateToSplitStorage();
    globalThis.storageMode = () => _ssStorageMode();
    globalThis.stored = key => _stored.get(key);

    // What a concurrent save does: take the SAME key and write a workbook that
    // includes a project the migration's snapshot never saw.
    globalThis.saveNewProjectConcurrently = () => _serializeKeyMutation('spreadsheets', async () => {
      globalThis.saveSawMode = _ssStorageMode();
      var current = _stored.get('spreadsheets');
      globalThis.saveRanAfterIndex = current && current.schema === SPREADSHEET_INDEX_SCHEMA;
      // A split-aware save writes its own document plus an index record.
      var doc = { id: 'fresh', name: 'Created during migration', activeId: 's1',
                  sheets: [{ id: 's1', name: 'Sheet1', rows: 5, cols: 5,
                             colWidths: [100, 100, 100, 100, 100], cells: {} }] };
      _stored.set('spreadsheet_fresh', doc);
      _durableStoreSnapshots.set('spreadsheet_fresh', doc);
      var index = _cloneJson(current);
      index.projects.push({ id: 'fresh', version: 1 });
      _stored.set('spreadsheets', index);
      _durableStoreSnapshots.set('spreadsheets', index);
    });
  `, context);

  assert.equal(context.storageMode(), 'legacy', 'starts legacy');

  const migration = context.migrate();
  // Wait until migration is genuinely inside its first document write.
  while (documentsSeen === 0) await new Promise(resolve => setTimeout(resolve, 5));

  // Now the user creates a project. Under the old code this ran immediately,
  // in legacy mode, and was overwritten. It must instead queue behind the
  // migration and run against split storage.
  const save = context.saveNewProjectConcurrently();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(context.saveSawMode, undefined,
    'the save has not started: migration holds the spreadsheets key');

  releaseFirstDocument();
  await migration;
  await save;

  assert.equal(context.saveRanAfterIndex, true,
    'the save ran after the migration index was committed, not before it');
  assert.equal(context.saveSawMode, 'split',
    'and it saw split storage, so it took the split branch');

  const index = context.stored('spreadsheets');
  const ids = index.projects.map(entry => entry.id).sort();
  assert.deepEqual(ids, ['fresh', 'old'],
    'both the migrated project and the one created during migration are in the index');
  assert.ok(context.stored('spreadsheet_old'), 'the migrated project has its document');
  assert.ok(context.stored('spreadsheet_fresh'), 'so does the one created during migration');

  // The index must be the LAST spreadsheets write, never a stale one landing after.
  const spreadsheetWrites = commits.filter(entry => entry.key === 'spreadsheets');
  assert.equal(spreadsheetWrites.length, 1, 'migration writes the index exactly once');
});

test('MB1188-003: a second migration call joins the one in flight', async () => {
  // Two callers must not queue two migrations; the second would rebuild an
  // index from a workbook the first already replaced.
  const context = vm.createContext({
    Promise, Map, Set, Array, Object, JSON, Number, String, Boolean, Date, setTimeout, TextEncoder,
    console: { warn() {}, error() {}, info() {}, log() {} },
    showToast() {},
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    var _keyMutationChains = new Map();
    var SPREADSHEET_INDEX_SCHEMA = 2;
    var SPREADSHEET_PROJECT_KEY_PREFIX = 'spreadsheet_';
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    var MAX_SPREADSHEET_TOMBSTONES = 175, MAX_SPREADSHEET_INDEX_RECORDS = 400;
    var MAX_SPREADSHEET_INDEX_BYTES = 64000, MAX_SPREADSHEET_PROJECTS = 25;
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80,
        MAX_RESOLVED_CONFLICT_IDS = 200, MAX_SPREADSHEET_CONFLICTS = 200;
    var _syncReady = false, _syncBootstrapComplete = false;
    var _durableStoreSnapshots = new Map();
    var _ssMigrationRan = false, _ssMigrationInFlight = null;
    var _newOperationId = () => 'op';
    var indexWriteCount = 0;
    var _stored = new Map();
    var STORE = { get: (key, fallback) => _stored.has(key) ? _stored.get(key) : fallback };
    async function _commitEncryptedSnapshot(key, serialized, normalized) {
      await new Promise(done => setTimeout(done, 5));
      if (key === 'spreadsheets') indexWriteCount += 1;
      _stored.set(key, normalized);
      _durableStoreSnapshots.set(key, normalized);
    }
    ${declaration('_serializeKeyMutation')}
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_ssStorageMode')}
    ${declaration('_ssProjectAsDoc')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssSplitWorkbook')}
    ${declaration('_ssMigrateToSplitStorage')}
    var legacy = normalizeSpreadsheetWorkbook({ activeProject: 'old', projects: [{
      id: 'old', name: 'Existing', activeId: 's1',
      sheets: [{ id: 's1', name: 'Sheet1', rows: 5, cols: 5,
                 colWidths: [100, 100, 100, 100, 100], cells: {} }] }] });
    _stored.set('spreadsheets', legacy);
    _durableStoreSnapshots.set('spreadsheets', legacy);
    globalThis.migrate = () => _ssMigrateToSplitStorage();
    globalThis.indexWrites = () => indexWriteCount;
  `, context);

  const [first, second] = await Promise.all([context.migrate(), context.migrate()]);
  assert.equal(first, true, 'the first call reports it migrated');
  assert.equal(second, true, 'the second reports the same outcome rather than a fresh run');
  assert.equal(context.indexWrites(), 1, 'the index is written once, not twice');
});

// ─────────────────────────────────────────────────────────────
// MB1188-007: shared human lists converge instead of overwriting.
//
// Every case below is one row of the two-device matrix. "Mac A" is the caller:
// it read `base` and saved `next`. "Mac B" already landed its change, so it is
// the difference between `base` and `current`. The merge must keep both.
// ─────────────────────────────────────────────────────────────
function recordListApi() {
  const context = vm.createContext({
    Map, Set, Array, Object, JSON, String, Number, Boolean,
    console: { warn() {}, error() {}, log() {} },
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    ${declaration('_recordListHasStableIds')}
    ${declaration('_recordListDelta')}
    ${declaration('_mergeRecordFields')}
    ${declaration('_applyRecordListDelta')}
    // What _persistRecordList does, minus the store: derive the delta from what
    // this Mac saw, then apply it to whatever is actually there now.
    globalThis.converge = (base, next, current) =>
      _applyRecordListDelta(current, _recordListDelta(base, next));
    globalThis.delta = (base, next) => _recordListDelta(base, next);
    globalThis.apply = (current, d) => _applyRecordListDelta(current, d);
    globalThis.stableIds = list => _recordListHasStableIds(list);
  `, context);
  return context;
}

const todo = (id, over = {}) => ({ id, text: 'item ' + id, done: false, ...over });
const ids = list => Array.from(list, record => record.id);

test('MB1188-007: add + add — both Macs keep their item', () => {
  const api = recordListApi();
  const base = [todo('a')];
  // Mac A adds "b"; Mac B has already added "c".
  const result = api.converge(base, [todo('a'), todo('b')], [todo('a'), todo('c')]);
  assert.deepEqual(ids(result).sort(), ['a', 'b', 'c'],
    'the whole-value save used to drop whichever add landed first');
});

test('MB1188-007: edit A + add B', () => {
  const api = recordListApi();
  const base = [todo('a')];
  const result = api.converge(base, [todo('a', { done: true })], [todo('a'), todo('b')]);
  assert.deepEqual(ids(result).sort(), ['a', 'b']);
  assert.equal(result.find(r => r.id === 'a').done, true, 'the tick survives');
});

test('MB1188-007: edit A + edit B — different records, both edits survive', () => {
  const api = recordListApi();
  const base = [todo('a'), todo('b')];
  const result = api.converge(
    base,
    [todo('a', { text: 'A edited' }), todo('b')],
    [todo('a'), todo('b', { text: 'B edited' })],
  );
  assert.equal(result.find(r => r.id === 'a').text, 'A edited');
  assert.equal(result.find(r => r.id === 'b').text, 'B edited');
});

test('MB1188-007: same record, different fields — both survive', () => {
  const api = recordListApi();
  const base = [todo('a', { text: 'original', done: false })];
  // A ticks the box; B rewrites the text. Neither should lose.
  const result = api.converge(
    base,
    [todo('a', { text: 'original', done: true })],
    [todo('a', { text: 'B rewrote this', done: false })],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].done, true, "A's tick survives");
  assert.equal(result[0].text, 'B rewrote this', "B's text survives");
});

test('MB1188-007: same record, same field — last writer wins, and only that field', () => {
  const api = recordListApi();
  const base = [todo('a', { text: 'original', done: false })];
  const result = api.converge(
    base,
    [todo('a', { text: 'A version', done: true })],
    [todo('a', { text: 'B version', done: false })],
  );
  // Documented behaviour, not an accident: a genuine same-field divergence on
  // a to-do is resolved in favour of the save being made. The tick, which only
  // A changed, is still kept.
  assert.equal(result[0].text, 'A version');
  assert.equal(result[0].done, true);
});

test('MB1188-007: delete A + add B', () => {
  const api = recordListApi();
  const base = [todo('a'), todo('b')];
  const result = api.converge(base, [todo('b')], [todo('a'), todo('b'), todo('c')]);
  assert.deepEqual(ids(result).sort(), ['b', 'c'], 'the delete applies and the add survives');
});

test('MB1188-007: delete on one Mac + edit on the other keeps the human text', () => {
  const api = recordListApi();
  const base = [todo('a', { text: 'original' })];
  // A edited it; B deleted it.
  const result = api.converge(base, [todo('a', { text: 'A typed this' })], []);
  assert.equal(result.length, 1, 'losing typing is worse than an extra row');
  assert.equal(result[0].text, 'A typed this');
});

test('MB1188-007: a record this Mac never saw is not treated as a deletion', () => {
  const api = recordListApi();
  // This is the exact shape of the original bug. Mac A read a list without
  // "c", so "c" is missing from what A saves — not because anyone deleted it.
  const base = [todo('a')];
  const result = api.converge(base, [todo('a'), todo('b')], [todo('a'), todo('c')]);
  assert.ok(result.some(r => r.id === 'c'), 'c is untouched, not pruned');
});

test('MB1188-007: replaying the same delta twice changes nothing', () => {
  const api = recordListApi();
  const base = [todo('a')];
  const d = api.delta(base, [todo('a', { done: true }), todo('b')]);
  const once = api.apply([todo('a')], d);
  const twice = api.apply(once, d);
  assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)),
    'duplicate delivery is idempotent');
});

test('MB1188-007: the order on screen is preserved, with unseen records after it', () => {
  const api = recordListApi();
  const base = [todo('a'), todo('b')];
  const result = api.converge(
    base,
    [todo('b'), todo('a')],                       // A reordered
    [todo('a'), todo('b'), todo('remote')],       // B added one
  );
  assert.deepEqual(ids(result), ['b', 'a', 'remote'],
    "the caller's order leads; what they never saw follows");
});

test('MB1188-007: a list without usable ids is refused, never merged by guess', () => {
  const api = recordListApi();
  assert.equal(api.stableIds([{ id: 'a' }, { id: 'b' }]), true);
  assert.equal(api.stableIds([{ id: 'a' }, { id: 'a' }]), false, 'duplicate ids');
  assert.equal(api.stableIds([{ id: 'a' }, { text: 'no id' }]), false, 'missing id');
  assert.equal(api.stableIds([{ id: 'a' }, null]), false, 'not a record');
  assert.equal(api.stableIds('nope'), false);
});

test('MB1188-007: the shared list savers no longer replace whole values', () => {
  // The four keys the audit named. If one of these regresses to STORE.replace,
  // every convergence property above becomes untrue at the call site while
  // still passing as a unit.
  for (const fn of ['saveTodos', 'saveAssignedTasks', 'savePolicies', 'saveStepUpReceipts']) {
    const body = declaration(fn);
    assert.doesNotMatch(body, /STORE\.replace\(/, `${fn} must not replace the whole list`);
    assert.match(body, /_persistRecordList\(/, `${fn} must save a semantic delta`);
  }
});

test('MB1188-007: shared records get collision-resistant ids, not Date.now()', () => {
  // Two Macs creating a to-do in the same millisecond produced the same id,
  // and the merge then treated two different items as one record.
  for (const fn of ['addTodoItem', 'addDashboardTodo', 'generateTodoFromLog',
                    'saveAssignedTask', 'addPolicy']) {
    let body;
    try { body = declaration(fn); } catch (_) { continue; }
    assert.doesNotMatch(body, /id: Date\.now\(\)/,
      `${fn} must not mint record ids from the clock alone`);
  }
});

test('MB1188-007: a replacement is refused when the durable base moved at the same revision', async () => {
  // The race the audit reproduced. The revision only moves when Firebase
  // delivers; a local commit changes the value and leaves it alone. The old
  // guard compared revisions only, so this replacement passed and erased an
  // already-acknowledged record with no error at all.
  const localStorage = new MemoryStorage({
    tmb_logs: 'E:["base"]',
    tmb_logs_revision: '4',
  });
  const durable = new Map([['logs', ['base']]]);
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: Object.assign(Object.create(null), { logs: ['base'] }),
    _durableStoreSnapshots: durable,
    _cloneJson: v => JSON.parse(JSON.stringify(v)),
    _lockedStorageKeys: new Set(),
    _storeWriteChains: new Map(),
    _storeWriteErrors: new Map(),
    _keyMutationChains: new Map(),
    _optimisticStoreValues: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    isSyncKey: k => k === 'logs',
    _newOperationId: () => 'op-local',
    _aesEncrypt: async p => 'E:' + p,
    _normalizeSyncValue: (_k, v) => JSON.parse(JSON.stringify(v)),
    _scheduleSyncDrain: async () => false,
    _writePendingSyncRecord: () => ({}),
  });
  vm.runInContext(`
    ${declaration('_serializeKeyMutation')}
    ${declaration('_localSyncRevision')}
    ${classDeclaration('SyncConflictError')}
    ${declaration('_commitEncryptedSnapshot')}
    ${declaration('_digestOfValue')}
    ${declaration('_readSyncMutationBase')}
    ${declaration('_queueEncryptedWrite')}
    globalThis.api = {
      // A semantic predecessor commits inside the same key lock. The revision
      // is untouched — this is a local write, not a Firebase delivery.
      predecessor: () => _serializeKeyMutation('logs', async () => {
        _durableStoreSnapshots.set('logs', ['base', 'predecessor']);
        _decCache.logs = ['base', 'predecessor'];
      }),
      replace: () => _queueEncryptedWrite('logs', ['base', 'replacement'], { operationId: 'op' }),
      cached: () => _decCache.logs,
      revision: () => _localSyncRevision('logs'),
    };
  `, context);

  const predecessor = context.api.predecessor();
  let code = null;
  const replacement = context.api.replace().catch(error => { code = error?.code; });
  await Promise.all([predecessor, replacement]);

  assert.equal(context.api.revision(), 4, 'the revision never moved — that is the point');
  assert.equal(code, 'SYNC_CONFLICT',
    'the replacement is refused because the value it was derived from is gone');
  assert.deepEqual([...context.api.cached()], ['base', 'predecessor'],
    'the acknowledged record survives instead of being silently erased');
});

// ─────────────────────────────────────────────────────────────
// MB1188-008: a profile added from the signed-out login screen reaches the
// other Macs. The login screen already promised this ("Elizabeth can sign in
// here to publish it") — the code simply never did it.
// ─────────────────────────────────────────────────────────────
function directoryPublishApi(overrides = {}) {
  const localStorage = new MemoryStorage(overrides.storage || {});
  const published = [];
  const context = contextWith({
    localStorage,
    _syncReady: overrides.syncReady === true,
    _syncBootstrapComplete: overrides.syncReady === true,
    isElizabeth: () => overrides.owner === true,
    showToast: (message, tone) => published.push({ toast: message, tone }),
    renderManageProfiles: () => {},
    STORE: {
      replace: async (key, value) => { published.push({ key, value }); return true; },
      flush: async () => {
        if (overrides.flushFails) throw new Error('Firebase is not connected');
        return true;
      },
    },
    window: {
      electronSession: overrides.bridgeMissing ? {} : {
        exportDirectory: async () => overrides.exportResult ||
          ({ ok: true, directory: [{ name: 'QA Front Desk', role: 'Front Desk' }] }),
      },
    },
  });
  vm.runInContext(`
    var DIRECTORY_PUBLISH_PENDING_KEY = 'tmb__directory_publish_pending';
    ${declaration('_directoryPublicationPending')}
    ${declaration('_setDirectoryPublicationPending')}
    ${declaration('publishStaffDirectory')}
    ${declaration('flushPendingDirectoryPublication')}
    globalThis.api = {
      publish: () => publishStaffDirectory(),
      flushPending: () => flushPendingDirectoryPublication(),
      pending: () => _directoryPublicationPending(),
      markPending: () => _setDirectoryPublicationPending(true),
    };
  `, context);
  return { context, published, localStorage };
}

test('MB1188-008: adding a profile while signed out records the debt', async () => {
  const { context } = directoryPublishApi({ owner: false });
  assert.equal(await context.api.publish(), false, 'a non-owner cannot publish');
  assert.equal(context.api.pending(), true,
    'the Mac remembers that its profile list is ahead of the others');
});

test('MB1188-008: the marker survives a restart', () => {
  // It is plain localStorage on purpose: the situation that creates it happens
  // before encrypted storage is unlocked.
  const first = directoryPublishApi({ owner: false });
  first.context.api.markPending();
  const carried = Object.fromEntries(first.localStorage.values);
  const second = directoryPublishApi({ owner: true, storage: carried });
  assert.equal(second.context.api.pending(), true, 'still owed after a relaunch');
});

test('MB1188-008: the owner signing in publishes and clears the marker', async () => {
  const { context, published } = directoryPublishApi({ owner: true, storage: {
    tmb__directory_publish_pending: '1',
  } });
  assert.equal(context.api.pending(), true);
  await context.api.flushPending();
  assert.equal(context.api.pending(), false, 'the debt is settled');
  const write = published.find(entry => entry.key === 'staff_directory');
  assert.ok(write, 'the directory was actually written');
  assert.deepEqual(Array.from(write.value, row => row.name), ['QA Front Desk']);
});

test('MB1188-008: someone else signing in leaves the marker for the owner', async () => {
  const { context, published } = directoryPublishApi({ owner: false, storage: {
    tmb__directory_publish_pending: '1',
  } });
  await context.api.flushPending();
  assert.equal(context.api.pending(), true, 'still pending — only the owner can publish');
  assert.equal(published.some(entry => entry.key === 'staff_directory'), false,
    'and nothing was written');
});

test('MB1188-008: the marker stays set when the write does not reach the cloud', async () => {
  const { context } = directoryPublishApi({
    owner: true, syncReady: true, flushFails: true,
    storage: { tmb__directory_publish_pending: '1' },
  });
  assert.equal(await context.api.publish(), false);
  assert.equal(context.api.pending(), true,
    'clearing on the local save alone is what made the old promise untrue');
});

test('MB1188-008: a rejected export does not clear the marker', async () => {
  const { context } = directoryPublishApi({
    owner: true, exportResult: { ok: false, error: 'refused' },
    storage: { tmb__directory_publish_pending: '1' },
  });
  assert.equal(await context.api.publish(), false);
  assert.equal(context.api.pending(), true);
});

test('MB1188-008: publication is a post-login maintenance job with a manual retry', () => {
  assert.match(declaration('runPostLoginMaintenance'),
    /\['staff directory publication', flushPendingDirectoryPublication\]/,
    'owner login must settle the debt, not just record it');
  assert.match(declaration('renderManageProfiles'), /retryDirectoryPublication\(\)/,
    'and the owner needs a way to retry it by hand');
  assert.match(declaration('renderManageProfiles'), /_directoryPublicationPending\(\)/,
    'shown only when something is actually pending');
});

// ── MB1188-017: a log body somebody wrote is never silently discarded ───────

test('MB1188-017: the 51st variant does not delete the 1st', () => {
  const { merge } = conflictMergeApi();
  // The audit supplied 51 unique bodies to the boundary and got 50 back:
  // body-00 was gone, with no error and nothing left to recover it from.
  let out = [{ ...CB, body: 'body-00', version: 2, baseVersion: 1,
    updated: '2026-08-01T10:00:00.000Z' }];
  for (let index = 1; index <= 60; index++) {
    const stamp = new Date(Date.parse('2026-08-01T10:00:00.000Z') + index * 1000).toISOString();
    out = merge(out, [{ ...CB, body: 'body-' + String(index).padStart(2, '0'),
      version: 2, baseVersion: 1, updated: stamp }]);
  }
  const kept = JSON.stringify(out);
  for (let index = 0; index <= 60; index++) {
    const body = 'body-' + String(index).padStart(2, '0');
    assert.ok(kept.includes(body), `${body} survives the boundary`);
  }
  assert.ok((out[0]._conflicts || []).length > 50, 'well past the old cap of 50');
});

test('MB1188-017: variants are bounded by refusal, not by deletion', () => {
  const source = declaration('_mergeConflictVariants');
  assert.doesNotMatch(source, /\.slice\(-MAX_CONFLICT_VARIANTS\)/, 'silent eviction is gone');
  assert.match(source, /CONFLICT_VARIANT_WARN_AT/, 'replaced by a warning');
  assert.match(script, /const CONFLICT_VARIANT_WARN_AT = 50;/);
});

test('MB1188-017: a resolution marker from an older build still settles its variant', () => {
  // The variant id moved to a 64-bit digest. Had the old form stopped being
  // recognised, every conflict already resolved would have come back once.
  const context = contextWith({ _cloneJson: v => JSON.parse(JSON.stringify(v)) });
  vm.runInContext(`
    ${declaration('_recordContentKey')}
    ${declaration('_ssDigest')}
    ${declaration('_conflictVariantKey')}
    ${declaration('_conflictVariantIdLegacy')}
    ${declaration('_conflictVariantId')}
    ${declaration('_conflictVariantIds')}
    ${declaration('_mergeConflictVariants')}
    globalThis.api = {
      legacyId: v => _conflictVariantIdLegacy(_conflictVariantKey(v)),
      merge: (groups, settled) => _mergeConflictVariants(groups, settled),
    };
  `, context);
  const variant = { id: 'r1', body: 'settled long ago' };
  const legacy = context.api.legacyId(variant);
  assert.match(legacy, /^cv_/, 'precondition: the old form');
  assert.equal(context.api.merge([[variant]], [legacy]).length, 0,
    'an old marker still retires its variant');
});

test('MB1188-017: the variant digest is 64-bit and markers are kept longer', () => {
  assert.match(declaration('_conflictVariantId'), /_ssDigest\(key\)/,
    'a 32-bit hash can collide, and a collision merges two people\u2019s text into one');
  assert.match(script, /const MAX_RESOLVED_CONFLICT_IDS = 2000;/);
});

// ── MB1188-018: one key's pending change must not retire the whole envelope ──

function icloudLoadApi(options) {
  const localStorage = new MemoryStorage(options.storage || {});
  const applied = [];
  const context = contextWith({
    localStorage,
    _encKey: {},
    window: { electronSync: { read: async () => ({ ok: true, data: options.envelope }) } },
    _assessCloudPinEpoch: async () => {},
    _decodeCloudEnvelope: async () => ({ decoded: options.decoded, rejected: [] }),
    _serializeKeyReconcile: (_key, task) => task(),
    _readPendingSyncRecord: name => options.pending.has(name),
    _localSyncRevision: () => 0,
    _persistRemoteValue: async (name, value) => { applied.push({ name, value }); },
    _refreshForSyncKey: () => {},
    showToast: () => {},
  });
  vm.runInContext(`
    ${declaration('_timestampMs')}
    ${declaration('loadFromiCloud')}
    globalThis.load = () => loadFromiCloud();
  `, context);
  return {
    load: () => context.load(),
    applied,
    watermark: () => localStorage.getItem('tmb__cloud_last_loaded'),
    storage: () => Object.fromEntries(localStorage.values),
  };
}

const ENVELOPE_AT = '2026-08-06T12:00:00.000Z';
const decodedPair = () => new Map([
  ['policies', { value: [{ id: 'p1' }], revision: 3, updated: ENVELOPE_AT }],
  ['todo_items', { value: [{ id: 't1' }], revision: 3, updated: ENVELOPE_AT }],
]);

test('MB1188-018: a key skipped for a pending change leaves the envelope unconsumed', async () => {
  // policies applies; todo_items is skipped because this Mac has not sent its
  // own change yet. Advancing the watermark here retired the envelope for BOTH,
  // and todo_items was never looked at again.
  const api = icloudLoadApi({
    envelope: { lastUpdated: ENVELOPE_AT },
    decoded: decodedPair(),
    pending: new Set(['todo_items']),
  });
  await api.load();
  assert.deepEqual(api.applied.map(entry => entry.name), ['policies'],
    'the unblocked key still applies');
  assert.equal(api.watermark(), null,
    'and the envelope is NOT marked consumed while a key is still unreviewed');
  assert.ok(api.storage().tmb_todo_items_cloud_deferred,
    'the skipped key leaves an explicit record rather than disappearing');
});

test('MB1188-018: the same envelope is reconsidered once the pending change clears', async () => {
  const first = icloudLoadApi({
    envelope: { lastUpdated: ENVELOPE_AT },
    decoded: decodedPair(),
    pending: new Set(['todo_items']),
  });
  await first.load();
  // Next login: the local change has been delivered, so nothing is pending.
  const second = icloudLoadApi({
    envelope: { lastUpdated: ENVELOPE_AT },
    decoded: decodedPair(),
    pending: new Set(),
    storage: first.storage(),
  });
  await second.load();
  assert.ok(second.applied.some(entry => entry.name === 'todo_items'),
    'the backup copy that was never reviewed is finally considered');
  assert.equal(second.watermark(), ENVELOPE_AT, 'and now the envelope is consumed');
  assert.equal(second.storage().tmb_todo_items_cloud_deferred, undefined,
    'the deferral record is cleared once it has been dealt with');
});

test('MB1188-018: an envelope with nothing deferred is consumed as before', async () => {
  const api = icloudLoadApi({
    envelope: { lastUpdated: ENVELOPE_AT },
    decoded: decodedPair(),
    pending: new Set(),
  });
  await api.load();
  assert.equal(api.applied.length, 2);
  assert.equal(api.watermark(), ENVELOPE_AT);
});

// ── MB1188-013: a malformed cloud record is refused, not stored ─────────────

function syncValidatorApi() {
  const context = contextWith({});
  vm.runInContext(`
    var MAX_SYNC_PLAINTEXT_BYTES = 600000;
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_estimateJsonBytes')}
    ${declaration('_expectedSyncType')}
    ${declaration('_validateSyncRecordList')}
    globalThis.api = {
      check: (key, value) => _validateSyncRecordList(key, value),
      identity: () => SYNC_RECORD_IDENTITY,
    };
  `, context);
  return context.api;
}

test('MB1188-013: a record without a usable id is refused', () => {
  const api = syncValidatorApi();
  for (const bad of [{ text: 'no id' }, { id: {} }, { id: [] }, { id: null }, { id: '' }]) {
    assert.throws(() => api.check('todo_items', [bad]), /todo_items record 1/,
      `${JSON.stringify(bad)} is refused`);
  }
});

test('MB1188-013: two records sharing an id are refused rather than merged', () => {
  // A merge keyed on identity would treat two different people's items as one.
  const api = syncValidatorApi();
  assert.throws(() => api.check('assigned_tasks', [{ id: 'a' }, { id: 'a' }]),
    /repeats id "a"/);
});

test('MB1188-013: a non-record entry is refused', () => {
  const api = syncValidatorApi();
  for (const bad of [null, 'text', 42, ['nested']]) {
    assert.throws(() => api.check('policies', [bad]), /is not a record/);
  }
});

test('MB1188-013: an oversized field is refused, not truncated', () => {
  // Truncating would be a silent edit to somebody's writing.
  const api = syncValidatorApi();
  assert.throws(() => api.check('staff_notes', [{ id: 'n1', body: 'x'.repeat(200001) }]),
    /oversized "body"/);
});

test('MB1188-013: staff_directory is keyed by name, which is all it has ever had', () => {
  const api = syncValidatorApi();
  api.check('staff_directory', [{ name: 'Ana', role: 'Front Desk' }]);
  assert.throws(() => api.check('staff_directory', [{ role: 'Front Desk' }]),
    /has no usable name/);
  assert.throws(() => api.check('staff_directory',
    [{ name: 'Ana', role: 'Front Desk' }, { name: 'Ana', role: 'Owner' }]),
    /repeats name "Ana"/);
});

test('MB1188-013: well-formed data passes untouched', () => {
  const api = syncValidatorApi();
  const todos = [{ id: 'r_1', text: 'Tune piano', done: false }, { id: 'r_2', text: 'Order reeds' }];
  assert.doesNotThrow(() => api.check('todo_items', todos));
  // Keys with no declared identity are not policed by this validator, so a
  // cache or an id list is unaffected.
  assert.doesNotThrow(() => api.check('comm_handled_ids', ['abc', 'def']));
  assert.doesNotThrow(() => api.check('sent_emails', [{ id: 1 }, { id: 1 }]));
});

test('MB1188-013: every human-data key has a declared identity', () => {
  // A new synchronized key that holds records should be added here on purpose,
  // not left to fall through unvalidated.
  const api = syncValidatorApi();
  const identity = api.identity();
  for (const key of ['logs', 'staff_notes', 'todo_items', 'assigned_tasks',
                     'policies', 'step_up_receipts', 'staff_directory']) {
    assert.ok(identity[key], `${key} declares how its records are identified`);
  }
  assert.match(declaration('_normalizeSyncValue'), /_validateSyncRecordList\(key, value\)/,
    'and the validator actually runs on the sync path');
});

test('MB1188-025: a rules rejection is reported as a rejection, not as pending', () => {
  // Firestore answers "Missing or insufficient permissions" when the deployed
  // rules do not admit the document. For a spreadsheet_<id> key that means the
  // rules predate per-project documents, so every project write is refused and
  // will go on being refused. Calling that "still pending" invites people to
  // wait for something that cannot happen.
  const toasts = [];
  const context = contextWith({
    setSyncStatus: () => {},
    showToast: (message, tone) => toasts.push({ message, tone }),
    _syncConflictNotified: new Set(),
    _updateSyncConflictActions: () => {},
  });
  vm.runInContext(`
    var SPREADSHEET_PROJECT_KEY_PREFIX = 'spreadsheet_';
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    const _syncPermissionNotified = new Set();
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_surfaceSyncDeliveryError')}
    globalThis.surface = (key, err) => _surfaceSyncDeliveryError(key, err);
  `, context);

  // The exact key and message seen in the app.
  context.surface('spreadsheet_proj_r_msjm7iuj_xFgoHf7oWMv',
    { message: 'Missing or insufficient permissions.' });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].tone, 'danger', 'this is a failure, not a delay');
  assert.match(toasts[0].message, /security rules/, 'it names the actual cause');
  assert.match(toasts[0].message, /saved on this Mac/, 'and says the work is safe');
  assert.doesNotMatch(toasts[0].message, /still pending/);

  // Repeats are silent: the rules stay wrong until somebody publishes them, and
  // the drain retries on a timer.
  context.surface('spreadsheet_proj_r_msjm7iuj_xFgoHf7oWMv',
    { message: 'Missing or insufficient permissions.' });
  assert.equal(toasts.length, 1, 'said once, not once a minute forever');

  // A different key still reports, and a genuinely transient failure is still
  // described as pending.
  context.surface('todo_items', { code: 'permission-denied', message: 'nope' });
  assert.match(toasts[1].message, /security rules do not allow it/);
  context.surface('logs', { message: 'network unreachable' });
  assert.match(toasts[2].message, /still pending/);
  assert.equal(toasts[2].tone, 'warning');
});

test('MB1188-025: the firestore rules admit a real project document key', () => {
  // The client and the rules have to agree on the shape of a project key. If
  // they drift, every per-project write is refused and the only symptom is a
  // toast about permissions.
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const match = /keyId\.matches\('(spreadsheet_[^']+)'\)/.exec(rules);
  assert.ok(match, 'the rules carry a project-key pattern');
  // Firestore matches() is fully anchored.
  const pattern = new RegExp('^' + match[1] + '$');
  for (const id of ['proj_r_msjm7iuj_xFgoHf7oWMv', 'proj_r_abc123_XYZ', 'proj_r_0_a']) {
    assert.ok(pattern.test('spreadsheet_' + id), `${id} is admitted by the rules`);
  }
  assert.ok(!pattern.test('spreadsheet_' + 'x'.repeat(200)), 'and the bound still holds');
});

// ── AUDIT: human data that was still being saved whole ──────────────────────

test('AUDIT/MB1188-027: flagging an email keeps the other Mac’s flags', () => {
  // flagged_emails is a set of message ids, not records, so the record-list
  // merge cannot key on it — and it was still being saved whole. Flagging an
  // email on one Mac erased whatever the other had flagged since.
  const context = contextWith({});
  vm.runInContext(`
    ${declaration('_persistIdSet')}
    // Expose the delta the way the real one computes it: once, outside the
    // mutator, so a re-run against a newer base is idempotent.
    globalThis.apply = (base, next, current) => {
      const baseSet = new Set(base.map(String));
      const nextSet = new Set(next.map(String));
      const added = [...nextSet].filter(id => !baseSet.has(id));
      const removed = [...baseSet].filter(id => !nextSet.has(id));
      const result = new Set(current.map(String));
      for (const id of removed) result.delete(id);
      for (const id of added) result.add(id);
      return [...result];
    };
  `, context);

  // This Mac flags 'a'. The other Mac has flagged 'b' in the meantime.
  assert.deepEqual(Array.from(context.apply([], ['a'], ['b'])).sort(), ['a', 'b'],
    'both flags survive');
  // Unflagging removes only what this Mac saw flagged.
  assert.deepEqual(Array.from(context.apply(['a'], [], ['a', 'b'])), ['b'],
    'unflagging one leaves the other alone');
  // Replaying the same intent changes nothing.
  const once = context.apply([], ['a'], ['b']);
  assert.deepEqual(Array.from(context.apply([], ['a'], once)).sort(), ['a', 'b'],
    'idempotent on replay');
});

test('AUDIT: no human-data key is saved as a whole value any more', () => {
  // The keys that hold something a person typed. Each of these was found by
  // this audit or the one before it; a new one appearing here would be the
  // same bug a fourth time.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const forbidden = [
    ["STORE.replace('todo_items'", 'to-dos'],
    ["STORE.replace('assigned_tasks'", 'assigned tasks'],
    ["STORE.replace('policies'", 'policies'],
    ["STORE.replace('step_up_receipts'", 'Step Up receipts'],
    ["STORE.replace('staff_notes'", 'team notes'],
    ["STORE.replace('flagged_emails'", 'email flags'],
  ];
  for (const [pattern, what] of forbidden) {
    assert.ok(!source.includes(pattern),
      `${what} must not be saved as a whole value — use _persistRecordList or _persistIdSet`);
  }
  // And the semantic paths are actually wired up.
  assert.match(declaration('deleteNote'), /_persistRecordList\('staff_notes'/);
  assert.match(declaration('toggleEmailFlag'), /_persistIdSet\('flagged_emails'/);
});

// ── 1.2.3 pentest P0-01: a flush must persist what is in memory ─────────────

function flushHarness() {
  const durable = { workbook: { activeProject: 'p1', projects: [] } };
  const written = [];
  const context = contextWith({
    _cloneJson: v => JSON.parse(JSON.stringify(v)),
    clearTimeout, setTimeout,
    _keyMutationChains: new Map(),
    _storeWriteChains: new Map(),
    _storeWriteErrors: new Map(),
    _durableStoreSnapshots: new Map(),
    _syncReady: false,
    _syncBootstrapComplete: false,
    _ssBlockedWorkbook: null,
    _ssAwaitingAuthority: false,
    _ssEditCell: null,
    document: { getElementById: () => null },
    showToast: () => {},
    ssGoHome: () => {},
    ssRenderActivityBar: () => {},
    ssRenderTabs: () => {},
    _ssAttributionActor: () => 'Tester',
    normalizeSpreadsheetWorkbook: v => JSON.parse(JSON.stringify(v)),
    normalizeSpreadsheetIndex: v => JSON.parse(JSON.stringify(v)),
    _ssStorageMode: () => 'split',
    _newOperationId: () => 'op',
    _scheduleSyncDrain: async () => false,
    // Stands in for the durable store. Recording what arrives here is the
    // whole point: the defect was a flush that wrote nothing and returned true.
    _ssCommitSplitWorkbook: async (_base, dirty) => {
      durable.workbook = JSON.parse(JSON.stringify(dirty));
      written.push('commit');
      return durable.workbook;
    },
    _ssDurableWorkbook: () => JSON.parse(JSON.stringify(durable.workbook)),
    STORE: { flush: async () => { written.push('flush'); return true; } },
  });
  vm.runInContext(`
    var _ssData = null, _ssSaveTimer = null, _ssSavePending = Promise.resolve(true),
        _ssSaveGate = null, _ssDirtyWorkbook = null, _ssDirtyBase = null,
        _ssDirtyGeneration = 0, _ssDirtyActor = null;
    ${declaration('_serializeKeyMutation')}
    ${declaration('_releaseSpreadsheetSaveGate')}
    ${declaration('_beginSpreadsheetSaveStage')}
    ${declaration('_stageDirtySpreadsheetSave')}
    ${declaration('_flushSpreadsheetSave')}
    globalThis.setWorkbook = book => { _ssData = book; };
    globalThis.flush = () => _flushSpreadsheetSave();
    globalThis.dirty = () => !!_ssDirtyWorkbook;
    globalThis.block = () => { _ssAwaitingAuthority = true; };
  `, context);
  return {
    context,
    durable: () => durable.workbook,
    written: () => written,
  };
}

test('P0-01: flushing persists a workbook change that was never staged', async () => {
  // The exact defect. The import did `_ssData = normalized` and then called the
  // flush, which only released an ALREADY-staged save. Nothing was written, and
  // every caller — import, delete, Save All, iCloud backup, the quit gate —
  // then reported success. The project was gone after restart.
  const api = flushHarness();
  api.context.setWorkbook({
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Google QA Import', activeId: 's1', sheets: [] }],
  });
  assert.equal(api.context.dirty(), false, 'precondition: nothing was staged');

  await api.context.flush();

  assert.deepEqual(api.durable().projects.map(p => p.name), ['Google QA Import'],
    'the flush staged and persisted what was in memory');
  assert.ok(api.written().includes('commit'), 'a durable commit actually happened');
  assert.ok(api.written().includes('flush'), 'and the store was flushed after it');
});

test('P0-01: a flush that cannot stage fails closed rather than claiming success', async () => {
  // Refusing is the point. The alternative is telling somebody their work is
  // saved when it is not, which is what Save All and the quit gate did.
  const api = flushHarness();
  api.context.setWorkbook({ activeProject: 'p1', projects: [{ id: 'p1', name: 'Held', activeId: 's1', sheets: [] }] });
  api.context.block();
  await assert.rejects(() => api.context.flush(), /could not be saved yet/);
  assert.equal(api.written().includes('commit'), false, 'and nothing was written');
});

test('P0-01: flushing an unchanged workbook is still safe', async () => {
  // Staging unconditionally is only acceptable because an unchanged workbook
  // costs nothing: the commit compares against the durable copy.
  const api = flushHarness();
  const book = { activeProject: 'p1', projects: [{ id: 'p1', name: 'Same', activeId: 's1', sheets: [] }] };
  api.context.setWorkbook(book);
  await api.context.flush();
  await api.context.flush();
  assert.deepEqual(api.durable().projects.map(p => p.name), ['Same']);
});
