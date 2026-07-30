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

test('a local STORE write queued during remote decode always commits after the remote value', async () => {
  const localStorage = new MemoryStorage();
  const pendingRecords = new Map();
  let remoteStartedResolve;
  let releaseRemoteDecode;
  const remoteStarted = new Promise(resolve => { remoteStartedResolve = resolve; });
  const remoteDecodeGate = new Promise(resolve => { releaseRemoteDecode = resolve; });
  const context = contextWith({
    localStorage,
    _encKey: {},
    _decCache: Object.create(null),
    _durableStoreSnapshots: new Map(),
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
    ${declaration('_queueEncryptedWrite')}
    ${declaration('_persistRemoteValue')}
    globalThis.mutationApi = {
      applyRemote: gate => _serializeKeyReconcile('logs', async () => {
        _markRemoteStarted();
        await gate;
        return _persistRemoteValue('logs', ['cloud'], 6);
      }),
      writeLocal: () => _queueEncryptedWrite('logs', ['local'], {
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

  assert.deepEqual([...context.mutationApi.cached()], ['local']);
  assert.equal(localStorage.getItem('tmb_logs'), 'E:["local"]');
  assert.equal(pendingRecords.get('logs').localCiphertext, 'E:["local"]');
  assert.equal(localStorage.getItem('tmb_logs_revision'), '6');
});

test('spreadsheet typing stays visible and commits after an already-running remote reconcile', async () => {
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
  remoteValue.projects[0].sheets[0].cells['0,0'].v = 'remote';
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
  assert.match(script, /_createSyncConflictBackup\(keys, 'keep-local'\)/);
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
