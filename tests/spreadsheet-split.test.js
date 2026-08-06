// MB161-012: one synchronized document per spreadsheet project.
//
// Firestore caps a document at 1 MiB on every plan with no way to raise it, but
// places no limit on documents per collection. Holding every project in one
// document capped the whole studio at roughly 9,000 filled cells; holding one
// project per document applies that budget to each project.
//
// These tests cover the storage model itself — splitting, reassembling, the
// index, and key naming. They are deliberately separate from the wiring.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const script = (() => {
  const matches = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const app = matches.find(match => match[0].startsWith('<script>'));
  assert.ok(app, 'the application inline script exists');
  return app[1];
})();

function declaration(name) {
  const starts = [
    script.indexOf(`function ${name}(`),
    script.indexOf(`async function ${name}(`),
  ].filter(index => index >= 0);
  assert.ok(starts.length, `${name} exists`);
  const start = Math.min(...starts);
  const after = [
    script.indexOf('\nfunction ', start + 1),
    script.indexOf('\nasync function ', start + 1),
    script.indexOf('\nclass ', start + 1),
  ].filter(index => index >= 0);
  return script.slice(start, after.length ? Math.min(...after) : script.length);
}

function splitApi() {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Math, TextEncoder,
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    var SPREADSHEET_INDEX_SCHEMA = 2;
    var MAX_SPREADSHEET_PROJECTS = 25;
    var SPREADSHEET_PROJECT_KEY_PREFIX = 'spreadsheet_';
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    var MAX_SPREADSHEET_CONFLICTS = 200;
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssProjectIdFromSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssSplitWorkbook')}
    ${declaration('_ssAssembleWorkbook')}
    globalThis.api = {
      key: id => _ssProjectSyncKey(id),
      isKey: key => _ssIsProjectSyncKey(key),
      idOf: key => _ssProjectIdFromSyncKey(key),
      isLegacy: value => _ssIsLegacyWorkbook(value),
      split: workbook => {
        const result = _ssSplitWorkbook(workbook);
        return { index: result.index, documents: Object.fromEntries(result.documents) };
      },
      assemble: (index, documents) => _ssAssembleWorkbook(index, documents),
      normIndex: value => normalizeSpreadsheetIndex(value),
      normProject: doc => normalizeSpreadsheetProject(doc),
    };
  `, context);
  return {
    key: id => context.api.key(id),
    isKey: key => context.api.isKey(key),
    idOf: key => context.api.idOf(key),
    isLegacy: v => context.api.isLegacy(v),
    split: w => JSON.parse(JSON.stringify(context.api.split(w))),
    assemble: (i, d) => JSON.parse(JSON.stringify(context.api.assemble(i, d))),
    normIndex: v => JSON.parse(JSON.stringify(context.api.normIndex(v))),
    normProject: d => JSON.parse(JSON.stringify(context.api.normProject(d))),
    raw: context.api,
  };
}

const cell = v => ({ v, bg: '', tc: '', b: false });
const sheet = (id, cells = {}) => ({
  id, name: id.toUpperCase(), rows: 20, cols: 8,
  colWidths: [100, 100, 100, 100, 100, 100, 100, 100], cells,
});
const project = (id, sheets, over = {}) => ({
  id, name: 'Project ' + id, activeId: sheets[0].id, sheets, ...over,
});
const legacyWorkbook = (projects, over = {}) => ({
  activeProject: projects[0].id, projects, ...over,
});

// ── Key naming ───────────────────────────────────────────────────────────────

test('MB161-012: a project key is derived from the id and reads back', () => {
  const api = splitApi();
  assert.equal(api.key('proj_r_abc123'), 'spreadsheet_proj_r_abc123');
  assert.equal(api.isKey('spreadsheet_proj_r_abc123'), true);
  assert.equal(api.idOf('spreadsheet_proj_r_abc123'), 'proj_r_abc123');
});

test('MB161-012: the key pattern refuses anything that is not a project id', () => {
  const api = splitApi();
  for (const bad of [
    'spreadsheet_',                       // empty id
    'spreadsheet_has/slash',              // a Firestore path separator
    'spreadsheet_has.dot',
    'spreadsheet_has space',
    'spreadsheet___proto__x!',
    'spreadsheets',                       // the index is not a project
    'spreadsheet_' + 'x'.repeat(101),     // over the bound
    'logs', '', null, undefined, 42,
  ]) {
    assert.equal(api.isKey(bad), false, `${String(bad)} must not be a project key`);
    assert.equal(api.idOf(bad), null);
  }
  assert.equal(api.isKey('spreadsheet_' + 'x'.repeat(100)), true, 'exactly at the bound is fine');
});

test('MB161-012: the client pattern and the rules pattern are the same pattern', () => {
  // They are enforced in two different languages against the same document
  // names. If they drift, the client writes keys the rules refuse — which is
  // exactly the failure that made check-out days undeliverable.
  assert.match(script, /SPREADSHEET_PROJECT_ID_PATTERN = \/\^\[A-Za-z0-9_-\]\{1,100\}\$\//);
  assert.match(rules, /keyId\.matches\('spreadsheet_\[A-Za-z0-9_-\]\{1,100\}'\)/);
  assert.match(rules, /function spreadsheetProjectKey\(keyId\)/);
  // And both the read allowlist and the write allowlist admit it.
  assert.match(rules, /function knownDataKey\(keyId\)\s*\{\s*return baseDataKey\(keyId\) \|\| spreadsheetProjectKey\(keyId\);/);
  assert.match(rules, /function writableDataKey\(keyId\)\s*\{\s*return baseDataKey\(keyId\) \|\| spreadsheetProjectKey\(keyId\);/);
});

test('MB161-012: project documents are still undeletable, like every data key', () => {
  // Absence must never mean deletion. A project is removed with a tombstone in
  // the index, not by deleting its document.
  const dataBlock = rules.slice(rules.indexOf('match /data/{keyId}'));
  assert.match(dataBlock.slice(0, dataBlock.indexOf('match /presence')),
    /allow delete: if false;/);
});

// ── Splitting ────────────────────────────────────────────────────────────────

test('MB161-012: a legacy workbook splits into an index and one document each', () => {
  const api = splitApi();
  const workbook = legacyWorkbook([
    project('p1', [sheet('s1', { '0,0': cell('A') })]),
    project('p2', [sheet('s2', { '0,0': cell('B') }), sheet('s3')]),
  ]);
  const { index, documents } = api.split(workbook);

  assert.equal(index.schema, 2);
  assert.deepEqual(index.projects.map(p => p.id), ['p1', 'p2']);
  assert.equal(index.activeProject, 'p1');
  assert.deepEqual(Object.keys(documents), ['spreadsheet_p1', 'spreadsheet_p2']);

  const second = documents.spreadsheet_p2;
  assert.equal(second.name, 'Project p2');
  assert.equal(second.sheets.length, 2, 'a project keeps all of its sheets');
  assert.equal(second.sheets[0].cells['0,0'].v, 'B');
  assert.equal(second.activeId, 's2');
});

test('MB161-012: split then assemble is the workbook you started with', () => {
  const api = splitApi();
  const workbook = legacyWorkbook([
    project('p1', [sheet('s1', { '0,0': cell('A'), '1,1': cell('B') })]),
    project('p2', [sheet('s2', { '2,2': cell('C') })]),
  ]);
  const { index, documents } = api.split(workbook);
  const rebuilt = api.assemble(index, documents);

  assert.equal(rebuilt.activeProject, workbook.activeProject);
  assert.deepEqual(rebuilt.projects.map(p => p.id), ['p1', 'p2']);
  assert.deepEqual(rebuilt.projects.map(p => p.name), ['Project p1', 'Project p2']);
  assert.equal(rebuilt.projects[0].sheets[0].cells['1,1'].v, 'B');
  assert.equal(rebuilt.projects[1].sheets[0].cells['2,2'].v, 'C');
});

test('MB161-012: a conflict follows the project it happened in', () => {
  const api = splitApi();
  const conflict = (id, projectId) => ({
    id, kind: 'cell', projectId, sheetId: 's1', target: '0,0',
    base: null, local: cell('mine'), remote: cell('theirs'),
    at: '2026-08-06T10:00:00.000Z',
  });
  const workbook = legacyWorkbook(
    [project('p1', [sheet('s1')]), project('p2', [sheet('s2')])],
    { _conflicts: [conflict('sc_a', 'p1'), conflict('sc_b', 'p2'), conflict('sc_c', 'p1')] },
  );
  const { documents } = api.split(workbook);
  assert.deepEqual(documents.spreadsheet_p1._conflicts.map(c => c.id), ['sc_a', 'sc_c']);
  assert.deepEqual(documents.spreadsheet_p2._conflicts.map(c => c.id), ['sc_b']);
});

test('MB161-012: a conflict naming a project that no longer exists is dropped, not thrown on', () => {
  const api = splitApi();
  const workbook = legacyWorkbook([project('p1', [sheet('s1')])], {
    _conflicts: [{
      id: 'sc_orphan', kind: 'cell', projectId: 'gone', sheetId: 's9', target: '0,0',
      base: null, local: cell('x'), remote: cell('y'), at: '2026-08-06T10:00:00.000Z',
    }],
  });
  assert.doesNotThrow(() => api.split(workbook));
  assert.equal(api.split(workbook).documents.spreadsheet_p1._conflicts, undefined);
});

test('MB161-012: resolution markers are copied to every project, not routed', () => {
  // A marker names a conflict id, not a project, so it cannot be routed. Every
  // project keeps the full set: the cost is a few bytes, and the cost of
  // guessing wrong is a resolved conflict coming back from the dead.
  const api = splitApi();
  const workbook = legacyWorkbook(
    [project('p1', [sheet('s1')]), project('p2', [sheet('s2')])],
    { _resolvedConflicts: ['sc_1', 'sc_2'] },
  );
  const { documents } = api.split(workbook);
  assert.deepEqual(documents.spreadsheet_p1._resolvedConflicts, ['sc_1', 'sc_2']);
  assert.deepEqual(documents.spreadsheet_p2._resolvedConflicts, ['sc_1', 'sc_2']);
});

// ── Assembling ───────────────────────────────────────────────────────────────

test('MB161-012: a project whose document has not arrived is absent, not deleted', () => {
  // This is the single most dangerous case in the whole design. On a fresh Mac
  // the index can arrive before the content. Treating a missing document as a
  // deletion would publish that deletion to the other Mac.
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }],
  });
  const partial = api.assemble(index, { spreadsheet_p1: { id: 'p1', name: 'One', activeId: 's1', sheets: [sheet('s1')] } });
  assert.deepEqual(partial.projects.map(p => p.id), ['p1'], 'only what has arrived is shown');
  assert.equal(partial.activeProject, 'p1');

  // And nothing about the assembled result records p2 as gone.
  assert.equal(JSON.stringify(partial).includes('_deleted'), false);
});

test('MB161-012: a tombstoned project is not assembled back into the workbook', () => {
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 2, _deleted: true, _deletedAt: '2026-08-06T10:00:00.000Z' }],
  });
  const assembled = api.assemble(index, {
    spreadsheet_p1: { id: 'p1', name: 'One', activeId: 's1', sheets: [sheet('s1')] },
    // The document still exists — deletions are tombstones, not deletes.
    spreadsheet_p2: { id: 'p2', name: 'Two', activeId: 's2', sheets: [sheet('s2')] },
  });
  assert.deepEqual(assembled.projects.map(p => p.id), ['p1']);
});

test('MB161-012: the open project falls back when it is gone or not yet loaded', () => {
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p2',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }],
  });
  const assembled = api.assemble(index, {
    spreadsheet_p1: { id: 'p1', name: 'One', activeId: 's1', sheets: [sheet('s1')] },
  });
  assert.equal(assembled.activeProject, 'p1', 'the editor never points at nothing');

  const empty = api.assemble(index, {});
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.activeProject, 'p2', 'with nothing loaded there is nothing to fall back to');
});

test('MB161-012: assembled conflicts and markers are gathered from every project', () => {
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }],
  });
  const assembled = api.assemble(index, {
    spreadsheet_p1: {
      id: 'p1', name: 'One', activeId: 's1', sheets: [sheet('s1')],
      _conflicts: [{ id: 'sc_a', kind: 'cell', projectId: 'p1' }],
      _resolvedConflicts: ['sc_x'],
    },
    spreadsheet_p2: {
      id: 'p2', name: 'Two', activeId: 's2', sheets: [sheet('s2')],
      _conflicts: [{ id: 'sc_b', kind: 'cell', projectId: 'p2' }],
      _resolvedConflicts: ['sc_x', 'sc_y'],
    },
  });
  assert.deepEqual(assembled._conflicts.map(c => c.id), ['sc_a', 'sc_b'],
    'the banner counts conflicts across the whole workbook');
  assert.deepEqual([...assembled._resolvedConflicts].sort(), ['sc_x', 'sc_y'],
    'and markers are de-duplicated rather than accumulating a copy per project');
});

// ── The index ────────────────────────────────────────────────────────────────

test('MB161-012: the index refuses a shape it does not recognise', () => {
  const api = splitApi();
  assert.throws(() => api.normIndex(null), /expected object data/);
  assert.throws(() => api.normIndex([]), /expected object data/);
  assert.throws(() => api.normIndex({ projects: [] }), /unrecognised schema/);
  assert.throws(() => api.normIndex({ schema: 99, projects: [] }), /unrecognised schema/);
  assert.throws(() => api.normIndex({ schema: 2 }), /no project list/);
  assert.throws(() => api.normIndex({ schema: 2, projects: [], extra: 1 }), /unexpected fields/);
});

test('MB161-012: the index refuses ids it could not turn into a document key', () => {
  const api = splitApi();
  for (const bad of ['', 'has/slash', 'has space', 'x'.repeat(101)]) {
    assert.throws(
      () => api.normIndex({ schema: 2, projects: [{ id: bad, version: 1 }] }),
      /invalid project id/,
      `id ${JSON.stringify(bad)} must be refused at the index, not at the write`);
  }
  assert.throws(
    () => api.normIndex({ schema: 2, projects: [{ id: 'p1', version: 1 }, { id: 'p1', version: 1 }] }),
    /duplicate project/);
});

test('MB161-012: only live projects count against the project limit', () => {
  const api = splitApi();
  const entries = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, version: 1 }));
  assert.doesNotThrow(() => api.normIndex({ schema: 2, projects: entries(25) }));
  assert.throws(() => api.normIndex({ schema: 2, projects: entries(26) }), /25-project limit/);

  // Tombstones must not consume the budget, or deleting a project to make room
  // would fail to make room.
  const withGraves = [
    ...entries(25),
    ...Array.from({ length: 30 }, (_, i) => ({ id: 'g' + i, version: 2, _deleted: true })),
  ];
  assert.doesNotThrow(() => api.normIndex({ schema: 2, projects: withGraves }));
});

test('MB161-012: the index keeps tombstones and does not resurrect them', () => {
  const api = splitApi();
  const normalized = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [
      { id: 'p1', version: 1, created: '2026-08-01T00:00:00.000Z' },
      { id: 'p2', version: 3, _deleted: true, _deletedAt: '2026-08-06T09:00:00.000Z' },
    ],
  });
  assert.equal(normalized.projects.length, 2, 'the tombstone survives the round trip');
  assert.equal(normalized.projects[1]._deleted, true);
  assert.equal(normalized.projects[1]._deletedAt, '2026-08-06T09:00:00.000Z');
  assert.equal(normalized.projects[0].created, '2026-08-01T00:00:00.000Z');
});

test('MB161-012: the open project never points at a tombstone or a stranger', () => {
  const api = splitApi();
  const deleted = api.normIndex({
    schema: 2, activeProject: 'p2',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 2, _deleted: true }],
  });
  assert.equal(deleted.activeProject, 'p1');

  const unknown = api.normIndex({
    schema: 2, activeProject: 'never-existed',
    projects: [{ id: 'p1', version: 1 }],
  });
  assert.equal(unknown.activeProject, 'p1');

  const nothing = api.normIndex({ schema: 2, activeProject: 'p1', projects: [] });
  assert.equal('activeProject' in nothing, false, 'with no projects there is nothing to open');
});

// ── A project document is a workbook, validated identically ──────────────────

test('MB161-012: a project document is validated by the workbook rules', () => {
  const api = splitApi();
  const good = { id: 'p1', name: 'Fall', activeId: 's1', sheets: [sheet('s1', { '0,0': cell('x') })] };
  const normalized = api.normProject(good);
  assert.equal(normalized.id, 'p1');
  assert.equal(normalized.name, 'Fall');
  assert.equal(normalized.sheets[0].cells['0,0'].v, 'x');

  // The same failures a workbook would produce, because it is the same code.
  assert.throws(() => api.normProject({ id: 'p1', name: 'x', activeId: 's1', sheets: [] }),
    /sheet/i);
  assert.throws(() => api.normProject({ id: 'p1', name: 'x', activeId: 's1',
    sheets: [{ ...sheet('s1'), rows: 9999 }] }), /unsafe sheet dimensions/);
});

test('MB161-012: the 600 KB budget now applies PER PROJECT', () => {
  const api = splitApi();
  // A project just under the ceiling is fine on its own...
  const cells = {};
  for (let i = 0; i < 8000; i += 1) cells[`${Math.floor(i / 100)},${i % 100}`] = cell('x'.repeat(10));
  const big = { id: 'p1', name: 'Big', activeId: 's1',
    sheets: [{ ...sheet('s1', cells), rows: 100, cols: 100, colWidths: [] }] };
  assert.doesNotThrow(() => api.normProject(big), 'one large project fits its own document');

  // ...and a second project of the same size is ALSO fine, which is the entire
  // point. Under the old single-document model these two together were over.
  const second = api.normProject({ ...big, id: 'p2', name: 'Also Big' });
  assert.equal(second.id, 'p2');

  const combined = JSON.stringify(big).length * 2;
  assert.ok(combined > 600000,
    'together they exceed what one document could ever have held');
});

test('MB161-012: a single project still cannot exceed one document', () => {
  const api = splitApi();
  const cells = {};
  for (let i = 0; i < 10001; i += 1) cells[`${Math.floor(i / 200)},${i % 200}`] = cell('x');
  assert.throws(
    () => api.normProject({ id: 'p1', name: 'Too big', activeId: 's1',
      sheets: [{ ...sheet('s1', cells), rows: 500, cols: 200, colWidths: [] }] }),
    /./,
    'the per-document ceiling is real, it has just moved');
});

// ── Recognising what we are looking at ───────────────────────────────────────

test('MB161-012: a legacy workbook is told apart from an index', () => {
  const api = splitApi();
  assert.equal(api.isLegacy(legacyWorkbook([project('p1', [sheet('s1')])])), true);
  assert.equal(api.isLegacy({ schema: 2, activeProject: 'p1', projects: [{ id: 'p1' }] }), false,
    'an index names projects but carries no sheets');
  assert.equal(api.isLegacy({ projects: [{ id: 'p1' }] }), false,
    'and neither does a list of bare ids');
  for (const junk of [null, undefined, [], 'x', 42, {}]) {
    assert.equal(api.isLegacy(junk), false, `${String(junk)} is not a workbook`);
  }
});

test('MB161-012: a project document round-trips through the workbook shape', () => {
  const api = splitApi();
  const doc = {
    id: 'p1', name: 'Fall', activeId: 's2',
    sheets: [sheet('s1'), sheet('s2', { '0,0': cell('x') })],
    _conflicts: [{ id: 'sc_a', kind: 'cell', projectId: 'p1' }],
    _resolvedConflicts: ['sc_b'],
  };
  const asWorkbook = api.raw.normProject
    ? JSON.parse(JSON.stringify(vmRoundTrip(api, doc)))
    : null;
  assert.deepEqual(asWorkbook, doc, 'nothing is invented and nothing is lost');
});

function vmRoundTrip(api, doc) {
  // Exercised through the two adapters rather than the normalizer, so this is
  // about shape preservation only.
  const context = vm.createContext({ JSON, Object, Array, Boolean, String });
  vm.runInContext(`
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    globalThis.trip = doc => _ssWorkbookToProjectDoc(_ssProjectDocToWorkbook(doc));
  `, context);
  return context.trip(doc);
}

test('MB161-012: an empty project document is refused rather than silently blank', () => {
  const context = vm.createContext({ JSON, Object, Array, Boolean, String, Error });
  vm.runInContext(`
    ${declaration('_ssWorkbookToProjectDoc')}
    globalThis.toDoc = wb => _ssWorkbookToProjectDoc(wb);
  `, context);
  assert.throws(() => context.toDoc({ projects: [] }), /has no project/);
  assert.throws(() => context.toDoc({}), /has no project/);
});

// ── Which keys sync ──────────────────────────────────────────────────────────

test('MB161-012: every project the index names is a synchronized key', () => {
  const context = vm.createContext({ Object, Set, Array, String, JSON });
  vm.runInContext(`
    var SPREADSHEET_PROJECT_KEY_PREFIX = 'spreadsheet_';
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    var SYNC_BASE_KEYS = ['logs', 'spreadsheets'];
    var _decCache = {
      spreadsheets: { schema: 2, activeProject: 'p1', projects: [
        { id: 'p1' }, { id: 'p2' }, { id: 'p3', _deleted: true },
      ] },
      // A project this Mac holds that the index has not caught up with.
      spreadsheet_p9: { id: 'p9' },
      logs: [],
    };
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssKnownProjectSyncKeys')}
    ${declaration('getSyncKeys')}
    ${declaration('isSyncKey')}
    globalThis.api = { keys: () => getSyncKeys(), is: k => isSyncKey(k) };
  `, context);

  const keys = [...context.api.keys()];
  assert.ok(keys.includes('spreadsheets'), 'the index still syncs');
  assert.ok(keys.includes('spreadsheet_p1'));
  assert.ok(keys.includes('spreadsheet_p2'));
  assert.ok(keys.includes('spreadsheet_p3'),
    'a tombstoned project keeps syncing, or the other Mac never learns it was deleted');
  assert.ok(keys.includes('spreadsheet_p9'),
    'a project held locally but not yet in the index is not dropped from sync');
  assert.equal(new Set(keys).size, keys.length, 'and nothing is listed twice');

  assert.equal(context.api.is('spreadsheet_p1'), true);
  assert.equal(context.api.is('spreadsheet_bad/id'), false);
  assert.equal(context.api.is('logs'), true);
});
