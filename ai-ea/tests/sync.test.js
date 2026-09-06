'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { merge, liveRecords, recordSyncState, summariseReport, SYNC_KEY, SyncError } = require('../src/sync');

// Canonical full-ISO forms: the engine normalises timestamps on the way in, so
// these are what comes back out.
const T1 = '2026-09-01T09:00:00.000Z';
const T2 = '2026-09-02T09:00:00.000Z';

function doc(over = {}) {
  return {
    sourceId: 'msg-1',
    date: '2026-03-14',
    entity: 'NMS',
    docType: 'RECEIPT',
    counterparty: 'Sweetwater Sound',
    amountCents: 128499,
    extension: 'pdf',
    ...over,
  };
}

function event(over = {}) {
  return { sourceId: 'ev-1', title: 'Standup', start: '2026-09-06T15:00:00Z', end: '2026-09-06T16:00:00Z', ...over };
}

function insert(incoming, collection = 'documents', source = 'gmail') {
  return merge({ collection, source, now: T1, existing: [], incoming: [incoming] }).records;
}

test('a first sync inserts and stamps provenance', () => {
  const { records, report } = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming: [doc()] });
  assert.equal(report.added.length, 1);
  assert.equal(records[0][SYNC_KEY].source, 'gmail');
  assert.equal(records[0][SYNC_KEY].sourceId, 'msg-1');
  assert.equal(records[0][SYNC_KEY].firstSeenAt, T1);
});

test('syncing the same batch twice changes nothing', () => {
  const first = insert(doc());
  const { records, report } = merge({ collection: 'documents', source: 'gmail', now: T2, existing: first, incoming: [doc()] });
  assert.equal(report.added.length, 0);
  assert.equal(report.unchanged.length, 1);
  assert.equal(records.length, 1);
});

// The promise the whole module exists to keep.
test('a category assigned by hand survives every later sync', () => {
  let records = insert(doc()).map(record => ({ ...record, category: 'equipment', businessPurpose: 'Studio B monitors' }));
  for (const at of [T2, '2026-09-03T09:00:00Z', '2026-09-04T09:00:00Z']) {
    records = merge({ collection: 'documents', source: 'gmail', now: at, existing: records, incoming: [doc()] }).records;
  }
  assert.equal(records[0].category, 'equipment');
  assert.equal(records[0].businessPurpose, 'Studio B monitors');
});

test('an overridden field keeps winning even when the feed insists', () => {
  let records = insert(doc({ entity: 'NMS' })).map(record => ({ ...record, entity: 'PERS' }));
  for (let i = 0; i < 3; i += 1) {
    records = merge({ collection: 'documents', source: 'gmail', now: T2, existing: records, incoming: [doc({ entity: 'NMS' })] }).records;
  }
  assert.equal(records[0].entity, 'PERS');
});

// Three-way merge: an untouched field should still benefit when the feed's own
// extraction improves.
test('an untouched local field takes the feed\'s newer value', () => {
  const first = insert(doc({ entity: 'NMS' }));
  const { records } = merge({ collection: 'documents', source: 'gmail', now: T2, existing: first, incoming: [doc({ entity: 'PERS' })] });
  assert.equal(records[0].entity, 'PERS');
});

test('remote-owned fields always refresh', () => {
  const first = insert(doc());
  const { records } = merge({ collection: 'documents', source: 'gmail', now: T2, existing: first, incoming: [doc({ amountCents: 129999 })] });
  assert.equal(records[0].amountCents, 129999);
});

test('a material change after classification is raised; before it, is not', () => {
  const classified = insert(doc()).map(record => ({ ...record, category: 'equipment' }));
  const after = merge({ collection: 'documents', source: 'gmail', now: T2, existing: classified, incoming: [doc({ amountCents: 129999 })] });
  assert.equal(after.report.conflicts.length, 1);
  assert.deepEqual(after.report.conflicts[0].yourFields, ['category']);
  assert.equal(after.report.conflicts[0].fields[0].was, 128499);

  const before = merge({ collection: 'documents', source: 'gmail', now: T2, existing: insert(doc()), incoming: [doc({ amountCents: 129999 })] });
  assert.equal(before.report.conflicts.length, 0, 'the feed catching up with itself is not worth an interruption');
});

test('records from another source are left completely alone', () => {
  const fromDrive = insert(doc({ sourceId: 'drive-9' }), 'documents', 'drive');
  const { records, report } = merge({
    collection: 'documents', source: 'gmail', now: T2, existing: fromDrive, incoming: [doc()],
  });
  assert.equal(report.untouched, 1);
  assert.equal(records.length, 2);
  assert.ok(records.some(record => record[SYNC_KEY].source === 'drive'));
});

test('hand-added records with no provenance are never touched by a sync', () => {
  const manual = { id: 'hand-1', date: '2026-01-01', entity: 'NMS', docType: 'RECEIPT', counterparty: 'Cash', amountCents: 500, extension: 'pdf' };
  const { records, report } = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [manual], incoming: [doc()] });
  assert.equal(report.untouched, 1);
  assert.ok(records.some(record => record.id === 'hand-1'));
});

// Only a full sync knows the batch is the whole picture. Getting this wrong
// would silently empty a calendar on the first incremental run.
test('only a full sync can conclude something was withdrawn', () => {
  const existing = merge({
    collection: 'calendar', source: 'gcal', now: T1, mode: 'full', existing: [],
    incoming: [event({ sourceId: 'ev-1' }), event({ sourceId: 'ev-2' })],
  }).records;

  const full = merge({ collection: 'calendar', source: 'gcal', now: T2, mode: 'full', existing, incoming: [event({ sourceId: 'ev-1' })] });
  assert.equal(full.report.withdrawn.length, 1);
  assert.equal(liveRecords(full.records).length, 1);

  const incremental = merge({ collection: 'calendar', source: 'gcal', now: T2, mode: 'incremental', existing, incoming: [event({ sourceId: 'ev-1' })] });
  assert.equal(incremental.report.withdrawn.length, 0);
  assert.equal(liveRecords(incremental.records).length, 2);
});

test('a withdrawn record is marked, never deleted', () => {
  const existing = merge({ collection: 'calendar', source: 'gcal', now: T1, mode: 'full', existing: [], incoming: [event()] }).records;
  const { records } = merge({ collection: 'calendar', source: 'gcal', now: T2, mode: 'full', existing, incoming: [] });
  assert.equal(records.length, 1, 'history stays in the file');
  assert.equal(records[0][SYNC_KEY].withdrawnAt, T2);
  assert.equal(liveRecords(records).length, 0, 'but it is not live');
});

test('withdrawing twice does not re-report or re-date it', () => {
  let records = merge({ collection: 'calendar', source: 'gcal', now: T1, mode: 'full', existing: [], incoming: [event()] }).records;
  records = merge({ collection: 'calendar', source: 'gcal', now: T2, mode: 'full', existing: records, incoming: [] }).records;
  const again = merge({ collection: 'calendar', source: 'gcal', now: '2026-09-03T09:00:00Z', mode: 'full', existing: records, incoming: [] });
  assert.equal(again.report.withdrawn.length, 0);
  assert.equal(again.records[0][SYNC_KEY].withdrawnAt, T2);
});

test('a record that comes back is restored', () => {
  let records = merge({ collection: 'calendar', source: 'gcal', now: T1, mode: 'full', existing: [], incoming: [event()] }).records;
  records = merge({ collection: 'calendar', source: 'gcal', now: T2, mode: 'full', existing: records, incoming: [] }).records;
  const back = merge({ collection: 'calendar', source: 'gcal', now: '2026-09-03T09:00:00Z', mode: 'full', existing: records, incoming: [event()] });
  assert.equal(back.report.restored.length, 1);
  assert.equal(liveRecords(back.records).length, 1);
});

test('one bad record does not abort the batch', () => {
  const { records, report } = merge({
    collection: 'documents', source: 'gmail', now: T1, existing: [],
    incoming: [doc(), { sourceId: 'bad', date: 'not-a-date' }, doc({ sourceId: 'msg-2' })],
  });
  assert.equal(report.added.length, 2);
  assert.equal(report.rejected.length, 1);
  assert.equal(records.length, 2);
});

test('a record with no sourceId is refused', () => {
  const { report } = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming: [{ date: '2026-03-14' }] });
  assert.match(report.rejected[0].reason, /no sourceId/);
});

test('the same record twice in one batch is a fetch bug, and says so', () => {
  const { records, report } = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming: [doc(), doc()] });
  assert.equal(records.length, 1);
  assert.match(report.rejected[0].reason, /more than once/);
});

test('incoming payloads cannot forge their own provenance', () => {
  const forged = { ...doc(), [SYNC_KEY]: { source: 'somewhere-else', sourceId: 'spoofed', firstSeenAt: '1999-01-01T00:00:00Z' } };
  const { records } = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming: [forged] });
  assert.equal(records[0][SYNC_KEY].source, 'gmail');
  assert.equal(records[0][SYNC_KEY].firstSeenAt, T1);
});

test('output order is stable so the file does not churn', () => {
  const incoming = [doc({ sourceId: 'c', date: '2026-03-03' }), doc({ sourceId: 'a', date: '2026-03-01' }), doc({ sourceId: 'b', date: '2026-03-02' })];
  const first = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming }).records.map(r => r.id);
  const second = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming: [...incoming].reverse() }).records.map(r => r.id);
  assert.deepEqual(first, second);
});

test('an unknown collection or mode is refused', () => {
  assert.throws(() => merge({ collection: 'invoices', source: 'x', now: T1 }), /unknown collection/);
  assert.throws(() => merge({ collection: 'documents', source: 'x', now: T1, mode: 'partial' }), SyncError);
  assert.throws(() => merge({ collection: 'documents', now: T1 }), /requires a source/);
});

test('sync state records a per-source watermark', () => {
  const { report } = merge({ collection: 'documents', source: 'gmail', now: T1, existing: [], incoming: [doc()] });
  const state = recordSyncState({}, { source: 'gmail', collection: 'documents', at: T1, mode: 'incremental', report });
  assert.equal(state.sources.gmail.lastSyncAt, T1);
  assert.equal(state.sources.gmail.lastCounts.added, 1);

  const second = recordSyncState(state, { source: 'gcal', collection: 'calendar', at: T2, mode: 'full', report });
  assert.ok(second.sources.gmail, 'other sources survive');
  assert.equal(second.sources.gcal.lastMode, 'full');
});

test('the summary names what needs eyes and what was rejected', () => {
  const classified = insert(doc()).map(record => ({ ...record, category: 'equipment' }));
  const { report } = merge({
    collection: 'documents', source: 'gmail', now: T2, existing: classified,
    incoming: [doc({ amountCents: 129999 }), { sourceId: 'bad' }],
  });
  const text = summariseReport(report);
  assert.match(text, /needs your eyes/);
  assert.match(text, /amountCents was 128499, now 129999/);
  assert.match(text, /1 rejected/);
});
