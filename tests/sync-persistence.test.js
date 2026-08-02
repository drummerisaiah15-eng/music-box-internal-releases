const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
  vm.runInContext(`
    const SYNC_PENDING_STORAGE_VERSION = 1;
    const MAX_SYNC_SUPERSEDED_OPS = 32;
    ${declaration('_pendingSyncStorageKey')}
    ${declaration('_localSyncRevision')}
    ${declaration('_validatePendingSyncRecord')}
    ${declaration('_readPendingSyncRecord')}
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
    _isCheckoutKey: () => false,
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
    ${declaration('normalizeSpreadsheetWorkbook')}
    _ssData = JSON.parse(JSON.stringify(initial));
    ${declaration('_refreshForSyncKey')}
    ${declaration('_mergeSpreadsheetEdits')}
    ${declaration('_releaseSpreadsheetSaveGate')}
    ${declaration('_beginSpreadsheetSaveStage')}
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
  vm.runInContext(`
    const SYNC_PENDING_STORAGE_VERSION = 1;
    const MAX_SYNC_SUPERSEDED_OPS = 32;
    ${declaration('_pendingSyncStorageKey')}
    ${declaration('_localSyncRevision')}
    ${declaration('_validatePendingSyncRecord')}
    ${declaration('_readPendingSyncRecord')}
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
  vm.runInContext(`
    const SYNC_CONFLICT_BACKUP_INDEX_KEY = 'tmb__sync_conflict_backup_index';
    const SYNC_CONFLICT_BACKUP_POINTER_KEY = 'tmb__last_sync_conflict_backup';
    const MAX_SYNC_CONFLICT_BACKUPS = 3;
    ${declaration('_bytesToB64')}
    ${declaration('_pendingSyncStorageKey')}
    ${declaration('_localSyncRevision')}
    ${declaration('_validatePendingSyncRecord')}
    ${declaration('_readPendingSyncRecord')}
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
  assert.match(rules, /checkoutKeyForDate\(request\.time - duration\.value\(45, 'd'\)\)/);
  assert.match(rules, /checkoutKeyForDate\(request\.time \+ duration\.value\(1, 'd'\)\)/);
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
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('_remoteStateIsAuthoritativelyAbsent')}
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
    ${declaration('normalizeSpreadsheetWorkbook')}
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
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('ssCreateDefaultSheets')}
    ${declaration('ssCreateDefaultData')}
    ${declaration('_remoteStateIsAuthoritativelyAbsent')}
    ${declaration('ssLoad')}
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
  // A delivered remote workbook clears the hold directly in _refreshForSyncKey.
  assert.ok(/_ssAwaitingAuthority = false;\s*\n\s*if \(document\.getElementById\('page-spreadsheets'\)/
    .test(script), 'an arriving remote workbook clears the hold');
});

test('V160-002: every editing entry point is refused while the editor is held', () => {
  assert.ok(script.includes('_ssBlockedWorkbook || _ssAwaitingAuthority || _ssImportInFlight'),
    'ssImportFile is gated');
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
  assert.ok(script.includes('replace: (k, v) =>'), 'STORE.replace() property exists');
  // persistInBackground must now route through replace() so it can write sync keys.
  assert.ok(
    script.includes('const write = STORE.replace(key, value);'),
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
  vm.runInContext(`
    const SYNC_MERGE_STRATEGIES = Object.freeze({ logs: 'tombstoned-record-list' });
    ${declaration('_canAutoMergeSyncKey')}
    ${declaration('_recordSortTime')}
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
