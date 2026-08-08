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
    var MAX_SPREADSHEET_TOMBSTONES = 175;
    var MAX_SPREADSHEET_INDEX_RECORDS = 400;
    var MAX_SPREADSHEET_INDEX_BYTES = 64000;
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
    ${declaration('_ssProjectAsDoc')}
    ${declaration('_ssIndexAfterEdit')}
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
      docToWorkbook: doc => _ssProjectDocToWorkbook(doc),
      workbookToDoc: wb => _ssWorkbookToProjectDoc(wb),
      normIndex: value => normalizeSpreadsheetIndex(value),
      normProject: doc => normalizeSpreadsheetProject(doc),
      projectAsDoc: (wb, id) => _ssProjectAsDoc(wb, id),
      indexAfter: (idx, base, next, at, deleted) => _ssIndexAfterEdit(idx, base, next, at, deleted),
    };
  `, context);
  return {
    key: id => context.api.key(id),
    isKey: key => context.api.isKey(key),
    idOf: key => context.api.idOf(key),
    isLegacy: v => context.api.isLegacy(v),
    split: w => JSON.parse(JSON.stringify(context.api.split(w))),
    assemble: (i, d) => JSON.parse(JSON.stringify(context.api.assemble(i, d))),
    docToWorkbook: d => JSON.parse(JSON.stringify(context.api.docToWorkbook(d))),
    workbookToDoc: w => JSON.parse(JSON.stringify(context.api.workbookToDoc(w))),
    normIndex: v => JSON.parse(JSON.stringify(context.api.normIndex(v))),
    normProject: d => JSON.parse(JSON.stringify(context.api.normProject(d))),
    projectAsDoc: (wb, id) => JSON.parse(JSON.stringify(context.api.projectAsDoc(wb, id) ?? null)),
    indexAfter: (idx, base, next, at, deleted) => JSON.parse(JSON.stringify(context.api.indexAfter(idx, base, next, at, deleted))),
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

// ── Routing: which strategy and which validator a key gets ───────────────────

function routingApi(decCache = {}) {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Math, TextEncoder,
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    _decCache: decCache,
    _estimateJsonBytes: value => JSON.stringify(value).length,
  });
  vm.runInContext(`
    var SPREADSHEET_INDEX_SCHEMA = 2;
    var MAX_SPREADSHEET_PROJECTS = 25;
    var SPREADSHEET_PROJECT_KEY_PREFIX = 'spreadsheet_';
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    var MAX_SYNC_PLAINTEXT_BYTES = 620000;
    var MAX_SPREADSHEET_TOMBSTONES = 175;
    var MAX_SPREADSHEET_INDEX_RECORDS = 400;
    var MAX_SPREADSHEET_INDEX_BYTES = 64000;
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    var MAX_SPREADSHEET_CONFLICTS = 200;
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    var SYNC_MERGE_STRATEGIES = {
      logs: 'tombstoned-record-list',
      staff_directory: 'tombstoned-record-list',
      spreadsheets: 'spreadsheet-index',
    };
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_syncMergeStrategy')}
    ${declaration('_canAutoMergeSyncKey')}
    ${declaration('_needsMergeBase')}
    ${declaration('_expectedSyncType')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_normalizeSyncValue')}
    globalThis.api = {
      strategy: key => _syncMergeStrategy(key),
      canMerge: key => _canAutoMergeSyncKey(key),
      needsBase: key => _needsMergeBase(key),
      type: key => _expectedSyncType(key),
      normalize: (key, value) => _normalizeSyncValue(key, value),
    };
  `, context);
  return context.api;
}

test('MB161-012: a project key gets the operation merge and needs a base', () => {
  const api = routingApi();
  assert.equal(api.strategy('spreadsheet_p1'), 'spreadsheet-operations');
  assert.equal(api.canMerge('spreadsheet_p1'), true);
  assert.equal(api.needsBase('spreadsheet_p1'), true,
    'a rebase without the starting point cannot tell whose edit is whose');
  assert.equal(api.type('spreadsheet_p1'), 'object');
});

test('MB161-012: the index gets the record-list merge and needs no base', () => {
  const api = routingApi({ spreadsheets: { schema: 2, projects: [] } });
  assert.equal(api.strategy('spreadsheets'), 'spreadsheet-index');
  assert.equal(api.canMerge('spreadsheets'), true);
  assert.equal(api.needsBase('spreadsheets'), false,
    'a tombstoned record list merges from both sides alone');
});

test('MB161-012: while a legacy workbook is still stored, the old merge applies', () => {
  // The migration has to be able to run on a Mac that is already syncing, so
  // the old shape must stay mergeable right up until it is gone. Getting this
  // wrong would strand an un-migrated Mac with an unmergeable key.
  const legacy = routingApi({
    spreadsheets: legacyWorkbook([project('p1', [sheet('s1')])]),
  });
  assert.equal(legacy.strategy('spreadsheets'), 'spreadsheet-operations');
  assert.equal(legacy.needsBase('spreadsheets'), true);

  // And once migrated, it flips without anything else changing.
  const migrated = routingApi({ spreadsheets: { schema: 2, projects: [{ id: 'p1' }] } });
  assert.equal(migrated.strategy('spreadsheets'), 'spreadsheet-index');
});

test('MB161-012: an unknown key still has no merge strategy at all', () => {
  const api = routingApi();
  assert.equal(api.strategy('todo_items'), undefined);
  assert.equal(api.canMerge('todo_items'), false,
    'auto-merge stays opt-in — a collection without tombstones must not be guessed at');
  assert.equal(api.canMerge('spreadsheet_bad/key'), false);
});

test('MB161-012: _normalizeSyncValue routes each shape to its own validator', () => {
  const api = routingApi();

  const doc = api.normalize('spreadsheet_p1', {
    id: 'p1', name: 'Fall', activeId: 's1', sheets: [sheet('s1', { '0,0': cell('x') })],
  });
  assert.equal(doc.id, 'p1');
  assert.equal(doc.sheets[0].cells['0,0'].v, 'x');
  assert.equal('projects' in doc, false, 'a project document is not a workbook');

  const index = api.normalize('spreadsheets', {
    schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }],
  });
  assert.equal(index.schema, 2);
  assert.deepEqual(index.projects.map(p => p.id), ['p1']);

  // The legacy shape is still accepted, or a Mac mid-migration loses its data.
  const legacy = api.normalize('spreadsheets', legacyWorkbook([project('p1', [sheet('s1')])]));
  assert.equal(legacy.projects[0].sheets.length, 1, 'read as a workbook, not an index');
  assert.equal('schema' in legacy, false);
});

test('MB161-012: a project document that is not a project is refused', () => {
  const api = routingApi();
  assert.throws(() => api.normalize('spreadsheet_p1', null), /./);
  assert.throws(() => api.normalize('spreadsheet_p1', []), /./);
  assert.throws(() => api.normalize('spreadsheet_p1', { id: 'p1' }), /./,
    'no sheets is not a valid project');
});

// ── Merging two indexes ──────────────────────────────────────────────────────

function indexMergeApi() {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, TextEncoder,
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    var SPREADSHEET_INDEX_SCHEMA = 2;
    var MAX_SPREADSHEET_PROJECTS = 25;
    var MAX_SPREADSHEET_TOMBSTONES = 175;
    var MAX_SPREADSHEET_INDEX_RECORDS = 400;
    var MAX_SPREADSHEET_INDEX_BYTES = 64000;
    var SPREADSHEET_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
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
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_mergeSpreadsheetIndexes')}
    globalThis.merge = (a, b) => _mergeSpreadsheetIndexes(a, b);
  `, context);
  return (a, b) => JSON.parse(JSON.stringify(context.merge(a, b)));
}

const idx = (projects, activeProject) => ({
  schema: 2, activeProject, projects,
});

test('MB161-012: a project created on each Mac survives on both', () => {
  const merge = indexMergeApi();
  const mine = idx([{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }], 'p2');
  const theirs = idx([{ id: 'p1', version: 1 }, { id: 'p3', version: 1 }], 'p3');
  const merged = merge(mine, theirs);
  assert.deepEqual(merged.projects.map(p => p.id).sort(), ['p1', 'p2', 'p3']);
  assert.equal(merged.activeProject, 'p2', 'and each Mac keeps the project it had open');

  // Symmetric: merging the other way round gives the same set.
  assert.deepEqual(
    merge(theirs, mine).projects.map(p => p.id).sort(), ['p1', 'p2', 'p3']);
});

test('MB161-012: a deletion beats a concurrent presence, and stays deleted', () => {
  const merge = indexMergeApi();
  const deletedHere = idx([
    { id: 'p1', version: 1 },
    { id: 'p2', version: 2, _deleted: true, _deletedAt: '2026-08-06T10:00:00.000Z' },
  ], 'p1');
  const stillThere = idx([{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }], 'p1');

  for (const merged of [merge(deletedHere, stillThere), merge(stillThere, deletedHere)]) {
    const p2 = merged.projects.find(p => p.id === 'p2');
    assert.ok(p2, 'the tombstone is kept — absence would let it come back');
    assert.equal(p2._deleted, true, 'and it stays deleted whichever side merged');
  }
});

test('MB161-012: the open project is not dragged to whatever the other Mac had', () => {
  const merge = indexMergeApi();
  const mine = idx([{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }], 'p1');
  const theirs = idx([{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }], 'p2');
  assert.equal(merge(mine, theirs).activeProject, 'p1');
  assert.equal(merge(theirs, mine).activeProject, 'p2');
});

test('MB161-012: an open project deleted on the other Mac falls back cleanly', () => {
  const merge = indexMergeApi();
  const mine = idx([{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }], 'p2');
  const theirs = idx([
    { id: 'p1', version: 1 },
    { id: 'p2', version: 2, _deleted: true, _deletedAt: '2026-08-06T10:00:00.000Z' },
  ], 'p1');
  const merged = merge(mine, theirs);
  assert.equal(merged.activeProject, 'p1', 'never left pointing at a tombstone');
});

test('MB161-012: merging an index with nothing on one side loses nothing', () => {
  const merge = indexMergeApi();
  const mine = idx([{ id: 'p1', version: 1 }], 'p1');
  assert.deepEqual(merge(mine, null).projects.map(p => p.id), ['p1']);
  assert.deepEqual(merge(mine, idx([], undefined)).projects.map(p => p.id), ['p1']);
  assert.deepEqual(merge(null, mine).projects.map(p => p.id), ['p1'],
    'a Mac with no index yet must not erase the one that has it');
});

test('MB161-012: merging indexes is idempotent', () => {
  const merge = indexMergeApi();
  const mine = idx([{ id: 'p1', version: 1 }, { id: 'p2', version: 2, _deleted: true }], 'p1');
  const theirs = idx([{ id: 'p1', version: 1 }, { id: 'p3', version: 1 }], 'p3');
  const once = merge(mine, theirs);
  assert.deepEqual(merge(once, once), once, 'merging a result with itself changes nothing');
  assert.deepEqual(merge(once, theirs).projects.map(p => p.id).sort(),
    once.projects.map(p => p.id).sort(), 'and re-merging an input adds nothing');
});

// ── The index after an edit: when absence means deletion, and when it doesn't ─
//
// The most dangerous logic in the split. A project whose document has not
// finished arriving is absent from _ssData. If that absence were read as a
// deletion, the tombstone would sync and delete the project off the other Mac.

const AT = '2026-08-06T12:00:00.000Z';

test('MB161-012: a project missing from BOTH base and result is untouched', () => {
  const api = splitApi();
  // p2 is in the index but its document has not arrived, so it is in neither
  // the base nor the edited workbook. It must survive completely unchanged.
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [
      { id: 'p1', version: 1, created: '2026-08-01T00:00:00.000Z' },
      { id: 'p2', version: 4, created: '2026-08-02T00:00:00.000Z' },
    ],
  });
  const loaded = legacyWorkbook([project('p1', [sheet('s1')])]);
  const edited = legacyWorkbook([project('p1', [sheet('s1', { '0,0': cell('typed') })])]);

  const next = api.indexAfter(index, loaded, edited, AT);
  const p2 = next.projects.find(p => p.id === 'p2');
  assert.ok(p2, 'still listed');
  assert.equal(p2._deleted, undefined, 'NOT tombstoned — it was never deleted, only not loaded');
  assert.equal(p2.version, 4, 'and its version is not disturbed');
});

test('MB161-012: a project deleted during the session IS tombstoned', () => {
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 2 }],
  });
  const before = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);
  const after = legacyWorkbook([project('p1', [sheet('s1')])]);

  const next = api.indexAfter(index, before, after, AT);
  const p2 = next.projects.find(p => p.id === 'p2');
  assert.equal(p2._deleted, true, 'it was there when editing began and is gone now');
  assert.equal(p2._deletedAt, AT);
  assert.equal(p2.version, 3, 'the version advances past the live record');
});

test('MB161-012: a project created during the session is added', () => {
  const api = splitApi();
  const index = api.normIndex({ schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] });
  const before = legacyWorkbook([project('p1', [sheet('s1')])]);
  const after = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);

  const next = api.indexAfter(index, before, after, AT);
  const p2 = next.projects.find(p => p.id === 'p2');
  assert.ok(p2, 'the new project is listed');
  assert.equal(p2.created, AT);
  assert.equal(p2.version, 1);
  assert.equal(p2._deleted, undefined);
});

test('MB161-012: recreating a deleted id is a new generation, not a resurrection', () => {
  const api = splitApi();
  // A tombstone whose version does not advance would keep winning the merge,
  // so the recreated project would silently vanish again.
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 5, _deleted: true, _deletedAt: '2026-08-05T00:00:00.000Z' }],
  });
  const before = legacyWorkbook([project('p1', [sheet('s1')])]);
  const after = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);

  const next = api.indexAfter(index, before, after, AT);
  const p2 = next.projects.find(p => p.id === 'p2');
  assert.equal(p2._deleted, undefined, 'it is live again');
  assert.equal(p2.version, 6, 'and outranks the tombstone it replaced');
});

test('MB161-012: an unchanged session changes nothing in the index', () => {
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 3, created: '2026-08-01T00:00:00.000Z' }],
  });
  const same = legacyWorkbook([project('p1', [sheet('s1')])]);
  assert.deepEqual(api.indexAfter(index, same, same, AT), index,
    'typing in a cell must not churn the index');
});

test('MB161-012: the first save with no index yet builds one from the session', () => {
  const api = splitApi();
  const workbook = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);
  const next = api.indexAfter(null, workbook, workbook, AT);
  assert.equal(next.schema, 2);
  assert.deepEqual(next.projects.map(p => p.id), ['p1', 'p2']);
  assert.equal(next.activeProject, 'p1');
});

test('MB161-012: the index refuses to record an id it could not address', () => {
  const api = splitApi();
  const workbook = legacyWorkbook([
    project('p1', [sheet('s1')]),
    project('has/slash', [sheet('s2')]),
  ]);
  const next = api.indexAfter(null, workbook, workbook, AT);
  assert.deepEqual(next.projects.map(p => p.id), ['p1'],
    'an id with no valid document key is not listed rather than listed and unwritable');
});

test('MB161-012: deleting every project is still an explicit deletion', () => {
  const api = splitApi();
  const index = api.normIndex({ schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] });
  const before = legacyWorkbook([project('p1', [sheet('s1')])]);
  const after = { activeProject: undefined, projects: [] };
  const next = api.indexAfter(index, before, after, AT);
  assert.equal(next.projects[0]._deleted, true);
  assert.equal('activeProject' in next, false, 'nothing left to open');
});

// ── _ssProjectAsDoc, shared by the split and the save ────────────────────────

test('MB161-012: a project doc carries its own conflicts and all the markers', () => {
  const api = splitApi();
  const workbook = legacyWorkbook(
    [project('p1', [sheet('s1')]), project('p2', [sheet('s2')])],
    {
      _conflicts: [
        { id: 'sc_a', kind: 'cell', projectId: 'p1' },
        { id: 'sc_b', kind: 'cell', projectId: 'p2' },
      ],
      _resolvedConflicts: ['sc_x', 'sc_y'],
    },
  );
  const doc = api.projectAsDoc(workbook, 'p1');
  assert.deepEqual(doc._conflicts.map(c => c.id), ['sc_a'], 'only its own conflicts');
  assert.deepEqual(doc._resolvedConflicts, ['sc_x', 'sc_y'], 'but every marker');
  assert.equal(doc.name, 'Project p1');
  assert.equal('projects' in doc, false);
});

test('MB161-012: asking for a project that is not there returns nothing', () => {
  const api = splitApi();
  const workbook = legacyWorkbook([project('p1', [sheet('s1')])]);
  assert.equal(api.projectAsDoc(workbook, 'nope'), null);
  assert.equal(api.projectAsDoc(null, 'p1'), null);
});

test('MB161-012: the split and the save agree on what a project document is', () => {
  // They used to be two separate blocks of routing logic. Two implementations
  // of "which conflict goes where" would eventually disagree, and the
  // disagreement would look like conflicts vanishing.
  const api = splitApi();
  const workbook = legacyWorkbook(
    [project('p1', [sheet('s1', { '0,0': cell('x') })]), project('p2', [sheet('s2')])],
    {
      _conflicts: [{ id: 'sc_a', kind: 'cell', projectId: 'p1' }],
      _resolvedConflicts: ['sc_z'],
    },
  );
  const { documents } = api.split(workbook);
  for (const id of ['p1', 'p2']) {
    assert.deepEqual(documents['spreadsheet_' + id], api.projectAsDoc(workbook, id),
      `${id} is identical whichever path produced it`);
  }
});

// ── The wiring: reading, writing and migrating for real ─────────────────────

function wiringApi({ store = {}, durable = {}, awaiting = false } = {}) {
  const committed = [];
  const drained = [];
  const toasts = [];
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {}, info() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Math, TextEncoder, Promise,
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    showToast: message => toasts.push(message),
    _newOperationId: () => 'op_' + committed.length,
    _serializeKeyMutation: (key, task) => task(),
    _scheduleSyncDrain: key => { drained.push(key); return Promise.resolve(); },
    _committed: committed,
    _storeBacking: store,
  });
  vm.runInContext(`
    // The MB161-012/013 constants arrive with the _ssStorageMode slice below;
    // declaring them here as well is a redeclaration.
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    var MAX_SPREADSHEET_CONFLICTS = 200;
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    var _syncReady = true, _syncBootstrapComplete = true;
    // _ssAwaitingAuthority / _ssBlockedWorkbook are module-level lets that
    // arrive with one of the slices below; assign rather than redeclare.
    var _durableStoreSnapshots = new Map(${JSON.stringify(Object.entries(durable))});
    var STORE = { get: (k, def) => (k in _storeBacking ? _storeBacking[k] : def) };
    async function _commitEncryptedSnapshot(key, serialized, snapshot) {
      _committed.push([key, JSON.parse(serialized)]);
      _storeBacking[key] = JSON.parse(serialized);
      _durableStoreSnapshots.set(key, JSON.parse(serialized));
    }
    ${declaration('_mergeResolvedConflictIds')}
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
    ${declaration('_mergeSpreadsheetEdits')}
    ${declaration('_ssProjectSyncKey')}
    ${declaration('_ssIsProjectSyncKey')}
    ${declaration('_ssIsLegacyWorkbook')}
    ${declaration('_ssProjectDocToWorkbook')}
    ${declaration('_ssWorkbookToProjectDoc')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('normalizeSpreadsheetProject')}
    ${declaration('normalizeSpreadsheetIndex')}
    ${declaration('_ssProjectAsDoc')}
    ${declaration('_ssIndexAfterEdit')}
    ${declaration('_ssSplitWorkbook')}
    ${declaration('_ssAssembleWorkbook')}
    ${declaration('_ssStorageMode')}
    ${declaration('_ssReadStoredWorkbook')}
    ${declaration('_ssCommitSplitWorkbook')}
    ${declaration('_ssMigrateToSplitStorage')}
    var currentUser = () => 'Tester';
    _ssAwaitingAuthority = ${awaiting ? 'true' : 'false'};
    _ssBlockedWorkbook = null;
    globalThis.api = {
      mode: () => _ssStorageMode(),
      read: () => _ssReadStoredWorkbook(),
      pending: () => _ssPendingProjectIds,
      commit: (base, next) => _ssCommitSplitWorkbook(base, next),
      migrate: () => _ssMigrateToSplitStorage(),
      store: () => _storeBacking,
    };
  `, context);
  return {
    api: context.api,
    committed,
    drained,
    toasts,
    store,
    plain: v => JSON.parse(JSON.stringify(v ?? null)),
  };
}

test('MB161-012: an un-migrated Mac still reads its single workbook', () => {
  const workbook = legacyWorkbook([project('p1', [sheet('s1', { '0,0': cell('x') })])]);
  const w = wiringApi({ store: { spreadsheets: workbook } });
  assert.equal(w.api.mode(), 'legacy');
  const read = w.plain(w.api.read());
  assert.equal(read.projects[0].sheets[0].cells['0,0'].v, 'x');
});

test('MB161-012: a migrated Mac assembles the workbook from its documents', () => {
  const w = wiringApi({ store: {
    spreadsheets: { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }] },
    spreadsheet_p1: { id: 'p1', name: 'One', activeId: 's1', sheets: [sheet('s1', { '0,0': cell('A') })] },
    spreadsheet_p2: { id: 'p2', name: 'Two', activeId: 's2', sheets: [sheet('s2', { '0,0': cell('B') })] },
  } });
  assert.equal(w.api.mode(), 'split');
  const read = w.plain(w.api.read());
  assert.deepEqual(read.projects.map(p => p.name), ['One', 'Two']);
  assert.equal(read.projects[1].sheets[0].cells['0,0'].v, 'B');
  assert.deepEqual([...w.api.pending()], []);
});

test('MB161-012: a project that has not downloaded is reported, not dropped silently', () => {
  const w = wiringApi({ store: {
    spreadsheets: { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }] },
    spreadsheet_p1: { id: 'p1', name: 'One', activeId: 's1', sheets: [sheet('s1')] },
  } });
  const read = w.plain(w.api.read());
  assert.deepEqual(read.projects.map(p => p.id), ['p1']);
  assert.deepEqual([...w.api.pending()], ['p2'],
    'the UI can say "still loading" instead of showing a short list that looks like loss');
});

test('MB161-012: one unreadable project does not make the others unreadable', () => {
  const w = wiringApi({ store: {
    spreadsheets: { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'bad', version: 1 }] },
    spreadsheet_p1: { id: 'p1', name: 'Good', activeId: 's1', sheets: [sheet('s1')] },
    spreadsheet_bad: { id: 'bad', name: 'Broken', activeId: 's9', sheets: 'not an array' },
  } });
  const read = w.plain(w.api.read());
  assert.deepEqual(read.projects.map(p => p.name), ['Good']);
  assert.deepEqual([...w.api.pending()], ['bad']);
  assert.equal(w.store.spreadsheet_bad.sheets, 'not an array',
    'and the broken document is left exactly as it is, not repaired or erased');
});

test('MB161-012: an unrecognised index refuses rather than guessing', () => {
  const w = wiringApi({ store: { spreadsheets: { schema: 99, projects: [] } } });
  assert.equal(w.api.mode(), 'unknown');
  assert.throws(() => w.api.read(), /does not recognise/);
});

test('MB161-012: saving writes only the project that changed', async () => {
  const before = legacyWorkbook([
    project('p1', [sheet('s1', { '0,0': cell('A') })]),
    project('p2', [sheet('s2', { '0,0': cell('B') })]),
  ]);
  const after = JSON.parse(JSON.stringify(before));
  after.projects[0].sheets[0].cells['0,0'] = cell('A EDITED');

  const w = wiringApi({
    store: {
      spreadsheets: { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }] },
      spreadsheet_p1: project('p1', [sheet('s1', { '0,0': cell('A') })]),
      spreadsheet_p2: project('p2', [sheet('s2', { '0,0': cell('B') })]),
    },
    durable: {
      spreadsheets: { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }] },
      spreadsheet_p1: project('p1', [sheet('s1', { '0,0': cell('A') })]),
      spreadsheet_p2: project('p2', [sheet('s2', { '0,0': cell('B') })]),
    },
  });

  await w.api.commit(before, after);
  const keys = w.committed.map(([key]) => key);
  assert.deepEqual(keys, ['spreadsheet_p1'],
    'p2 was untouched and the index did not change, so neither was rewritten');
  assert.equal(w.store.spreadsheet_p1.sheets[0].cells['0,0'].v, 'A EDITED');
  assert.equal(w.store.spreadsheet_p2.sheets[0].cells['0,0'].v, 'B', 'and p2 is byte-identical');
});

test('MB161-012: creating a project writes its document AND the index', async () => {
  const before = legacyWorkbook([project('p1', [sheet('s1')])]);
  const after = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);
  const index = { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] };
  const w = wiringApi({
    store: { spreadsheets: index, spreadsheet_p1: project('p1', [sheet('s1')]) },
    durable: { spreadsheets: index, spreadsheet_p1: project('p1', [sheet('s1')]) },
  });

  await w.api.commit(before, after);
  const keys = w.committed.map(([key]) => key);
  assert.deepEqual(keys, ['spreadsheet_p2', 'spreadsheets'],
    'the document is written before the index that names it');
  assert.ok(w.store.spreadsheets.projects.some(p => p.id === 'p2' && !p._deleted));
});

test('MB161-012: deleting a project tombstones it and leaves the document alone', async () => {
  const before = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);
  const after = legacyWorkbook([project('p1', [sheet('s1')])]);
  const index = { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }] };
  const w = wiringApi({
    store: { spreadsheets: index, spreadsheet_p1: project('p1', [sheet('s1')]), spreadsheet_p2: project('p2', [sheet('s2')]) },
    durable: { spreadsheets: index, spreadsheet_p1: project('p1', [sheet('s1')]), spreadsheet_p2: project('p2', [sheet('s2')]) },
  });

  await w.api.commit(before, after);
  assert.deepEqual(w.committed.map(([key]) => key), ['spreadsheets'],
    'only the index changes — a deletion is a tombstone, not a document rewrite');
  const p2 = w.store.spreadsheets.projects.find(p => p.id === 'p2');
  assert.equal(p2._deleted, true);
  assert.ok(w.store.spreadsheet_p2, 'the content is still there, recoverable');
});

test('MB161-012: a project that never loaded is NOT deleted by someone else editing', async () => {
  // The scenario that would lose a whole project. p2 is in the index, its
  // document has not arrived, so it is in neither the base nor the result.
  const loaded = legacyWorkbook([project('p1', [sheet('s1')])]);
  const edited = legacyWorkbook([project('p1', [sheet('s1', { '0,0': cell('typed') })])]);
  const index = { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 7 }] };
  const w = wiringApi({
    store: { spreadsheets: index, spreadsheet_p1: project('p1', [sheet('s1')]) },
    durable: { spreadsheets: index, spreadsheet_p1: project('p1', [sheet('s1')]) },
  });

  await w.api.commit(loaded, edited);
  assert.deepEqual(w.committed.map(([key]) => key), ['spreadsheet_p1'],
    'the index is not rewritten at all');
  const p2 = w.store.spreadsheets.projects.find(p => p.id === 'p2');
  assert.equal(p2._deleted, undefined, 'p2 survives untouched');
  assert.equal(p2.version, 7);
});

test('MB161-012: an idle save writes nothing', async () => {
  const same = legacyWorkbook([project('p1', [sheet('s1', { '0,0': cell('A') })])]);
  const index = { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] };
  const doc = project('p1', [sheet('s1', { '0,0': cell('A') })]);
  const w = wiringApi({
    store: { spreadsheets: index, spreadsheet_p1: doc },
    durable: { spreadsheets: index, spreadsheet_p1: doc },
  });
  await w.api.commit(same, same);
  assert.deepEqual(w.committed, [], 'no keystroke should rewrite every document');
});

// ── Migration ───────────────────────────────────────────────────────────────

test('MB161-012: migration writes every document, then the index', async () => {
  const workbook = legacyWorkbook([
    project('p1', [sheet('s1', { '0,0': cell('A') })]),
    project('p2', [sheet('s2', { '0,0': cell('B') })]),
  ]);
  const w = wiringApi({ store: { spreadsheets: workbook } });

  assert.equal(await w.api.migrate(), true);
  const keys = w.committed.map(([key]) => key);
  assert.deepEqual(keys, ['spreadsheet_p1', 'spreadsheet_p2', 'spreadsheets'],
    'the index is written LAST, so it never names a document that is not there yet');

  assert.equal(w.api.mode(), 'split', 'and the Mac is now on the new shape');
  const read = w.plain(w.api.read());
  assert.deepEqual(read.projects.map(p => p.name), ['Project p1', 'Project p2']);
  assert.equal(read.projects[0].sheets[0].cells['0,0'].v, 'A',
    'with every cell intact — this is the step that could lose everything');
  assert.equal(read.projects[1].sheets[0].cells['0,0'].v, 'B');
  assert.ok(w.toasts.some(t => /each project separately/.test(t)), 'and it says what happened');
});

test('MB161-012: migration runs once and is a no-op afterwards', async () => {
  const workbook = legacyWorkbook([project('p1', [sheet('s1')])]);
  const w = wiringApi({ store: { spreadsheets: workbook } });
  assert.equal(await w.api.migrate(), true);
  const after = w.committed.length;
  assert.equal(await w.api.migrate(), false, 'a second attempt does nothing');
  assert.equal(w.committed.length, after);
});

test('MB161-012: an already-split Mac is never migrated again', async () => {
  const w = wiringApi({ store: {
    spreadsheets: { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] },
    spreadsheet_p1: project('p1', [sheet('s1')]),
  } });
  assert.equal(await w.api.migrate(), false);
  assert.deepEqual(w.committed, []);
});

test('MB161-012: migration will not run on a workbook this Mac invented', async () => {
  // The same rule that stops a fabricated default being published. Migrating
  // an invented workbook would publish it as real, per project.
  const workbook = legacyWorkbook([project('p1', [sheet('s1')])]);
  const w = wiringApi({ store: { spreadsheets: workbook }, awaiting: true });
  assert.equal(await w.api.migrate(), false);
  assert.deepEqual(w.committed, [], 'nothing is written while remote state is unknown');
});

test('MB161-012: migration preserves conflicts, routed to their project', async () => {
  const workbook = legacyWorkbook(
    [project('p1', [sheet('s1')]), project('p2', [sheet('s2')])],
    {
      _conflicts: [
        { id: 'sc_a', kind: 'cell', projectId: 'p1', sheetId: 's1', target: '0,0',
          base: null, local: cell('mine'), remote: cell('theirs'), at: AT },
      ],
      _resolvedConflicts: ['sc_old'],
    },
  );
  const w = wiringApi({ store: { spreadsheets: workbook } });
  await w.api.migrate();
  assert.deepEqual(w.store.spreadsheet_p1._conflicts.map(c => c.id), ['sc_a'],
    'a preserved losing value survives the migration');
  assert.equal(w.store.spreadsheet_p2._conflicts, undefined);
  assert.deepEqual(w.store.spreadsheet_p1._resolvedConflicts, ['sc_old']);
});

test('MB161-012: a failed migration leaves the old document authoritative', async () => {
  // A partial migration is survivable only because of the ORDER: every project
  // document is written first and the index last, so until the index lands the
  // old single document is still what _ssStorageMode reports and still what
  // gets read.
  const workbook = legacyWorkbook([project('p1', [sheet('s1')]), project('p2', [sheet('s2')])]);
  const w = wiringApi({ store: { spreadsheets: workbook } });
  assert.equal(w.api.mode(), 'legacy');

  const migrate = declaration('_ssMigrateToSplitStorage');
  assert.ok(migrate.indexOf('for (const [key, doc] of documents)') <
            migrate.indexOf("_commitEncryptedSnapshot('spreadsheets'"),
    'documents are committed before the index that names them');
  assert.match(migrate, /_ssMigrationRan = false;/,
    'a failure re-arms the migration rather than marking it done');
  assert.match(migrate, /Your data is unchanged/, 'and says so plainly');
  assert.match(migrate, /if \(_ssAwaitingAuthority \|\| _ssBlockedWorkbook\) return false;/,
    'and it never runs while remote state is unknown');
});

// ── MB161-013: the index is the one document that opens other documents ─────
//
// _ssKnownProjectSyncKeys deliberately includes tombstoned projects, because
// their documents must keep syncing or the other Mac never learns of the
// deletion. That makes the index the thing that decides how many Firestore
// listeners this Mac opens, and tombstones counted against nothing.

test('MB161-013: an index stuffed with tombstones is refused, not subscribed to', () => {
  const api = splitApi();
  const graves = Array.from({ length: 50000 }, (_, i) => ({
    id: 'p' + i, version: 2, _deleted: true, _deletedAt: '2026-01-01T00:00:00.000Z',
  }));
  // One live project, so the 25-project limit passes cleanly. This is what the
  // old code accepted, and getSyncKeys would then have returned 50,000 keys.
  assert.throws(
    () => api.normIndex({ schema: 2, activeProject: 'live', projects: [{ id: 'live', version: 1 }, ...graves] }),
    /too large to be genuine|more projects than it could ever have held/);
});

test('MB161-013: the size check happens before the payload is walked', () => {
  const api = splitApi();
  // Few records, each enormous. A record-count check alone would let this in.
  const fat = Array.from({ length: 20 }, (_, i) => ({
    id: 'p' + i, version: 1, created: 'x'.repeat(9000),
  }));
  assert.throws(() => api.normIndex({ schema: 2, activeProject: 'p0', projects: fat }),
    /too large to be genuine/);
});

test('MB161-013: ordinary deletion history is compacted, never refused', () => {
  const api = splitApi();
  // A studio that has deleted 300 projects over the years must not find its
  // app bricked — refusing here would be worse than the problem.
  const graves = Array.from({ length: 300 }, (_, i) => ({
    id: 'g' + i, version: 2, _deleted: true,
    _deletedAt: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
  }));
  const normalized = api.normIndex({
    schema: 2, activeProject: 'live',
    projects: [{ id: 'live', version: 1 }, ...graves],
  });
  const kept = normalized.projects.filter(p => p._deleted);
  assert.equal(kept.length, 175, 'compacted to the tombstone cap');
  assert.ok(normalized.projects.some(p => p.id === 'live' && !p._deleted),
    'and every live project is kept regardless');

  // The OLDEST go first: resurrecting one needs a Mac offline since before that
  // deletion that still holds the project.
  assert.equal(kept.some(p => p.id === 'g0'), false, 'the oldest tombstone is dropped');
  assert.equal(kept.some(p => p.id === 'g299'), true, 'the newest is kept');
});

test('MB161-013: compaction never drops a live project to make room', () => {
  const api = splitApi();
  const live = Array.from({ length: 25 }, (_, i) => ({ id: 'p' + i, version: 1 }));
  const graves = Array.from({ length: 300 }, (_, i) => ({
    id: 'g' + i, version: 2, _deleted: true,
    _deletedAt: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
  }));
  const normalized = api.normIndex({ schema: 2, activeProject: 'p0', projects: [...live, ...graves] });
  assert.equal(normalized.projects.filter(p => !p._deleted).length, 25,
    'all 25 live projects survive');
  assert.equal(normalized.projects.filter(p => p._deleted).length, 175);
});

test('MB161-013: a normal index is not disturbed by any of this', () => {
  const api = splitApi();
  const plain = {
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 3, _deleted: true, _deletedAt: '2026-08-01T00:00:00.000Z' }],
  };
  const once = api.normIndex(plain);
  assert.equal(once.projects.length, 2);
  assert.deepEqual(api.normIndex(once), once, 'and normalizing is still idempotent');
});

test('MB161-012: capacity is measured per project once storage is split', () => {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Object, Array, JSON, Number, String, Boolean, Math, TextEncoder,
    _mode: 'split',
  });
  vm.runInContext(`
    var MAX_SPREADSHEET_TOTAL_CELLS = 10000;
    var MAX_SPREADSHEET_TOTAL_CHARS = 400000;
    var MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000;
    function _ssStorageMode() { return _mode; }
    ${declaration('_ssProjectAsDoc')}
    ${declaration('_ssCapacity')}
    globalThis.api = { level: (wb, id) => _ssCapacity(wb, id), setMode: m => { _mode = m; } };
  `, context);

  const filled = n => {
    const cells = {};
    for (let i = 0; i < n; i += 1) cells[`${Math.floor(i / 100)},${i % 100}`] = cell('x'.repeat(10));
    return cells;
  };
  const workbook = legacyWorkbook([
    project('p1', [{ ...sheet('s1'), cells: filled(4000) }]),
    project('p2', [{ ...sheet('s2'), cells: filled(4000) }]),
    project('p3', [{ ...sheet('s3'), cells: filled(4000) }]),
  ]);

  // Split: each project is measured against its own document budget.
  assert.equal(context.api.level(workbook, 'p1').cells.used, 4000);
  assert.ok(context.api.level(workbook, 'p1').fraction < 0.5,
    'a project using 4,000 of its own 10,000 cells is not nearly full');

  // Legacy: the same data shares one budget and IS over.
  context.api.setMode('legacy');
  const shared = context.api.level(workbook, 'p1');
  assert.equal(shared.cells.used, 12000, 'the old shape counts every project together');
  assert.equal(shared.fraction, 1);
});

test('MB161-027: a deletion survives a base that cannot show it', () => {
  // The exact reported failure. _stageDirtySpreadsheetSave falls back to
  // cloning the LIVE workbook when there is no durable snapshot, and that clone
  // is taken after the project has already been spliced out. So the base and
  // the result are identical, the diff sees no deletion, the index keeps
  // listing the project, and the next reassemble brings it back — "I delete it
  // and it returns when I switch tabs".
  const api = splitApi();
  const index = api.normIndex({
    schema: 2, activeProject: 'p1',
    projects: [{ id: 'p1', version: 1 }, { id: 'p2', version: 1 }],
  });
  const after = legacyWorkbook([project('p1', [sheet('s1')])]);

  // Base === result: p2 is already gone from both.
  const inferred = api.indexAfter(index, after, after, AT);
  assert.equal(inferred.projects.find(p => p.id === 'p2')._deleted, undefined,
    'the diff genuinely cannot see it — this is the bug, reproduced');

  // Told explicitly, it is buried regardless of what the base looks like.
  const explicit = api.indexAfter(index, after, after, AT, ['p2']);
  const p2 = explicit.projects.find(p => p.id === 'p2');
  assert.equal(p2._deleted, true);
  assert.equal(p2._deletedAt, AT);
  assert.equal(p2.version, 2, 'and advances past the live record so the merge picks it');
});

test('MB161-027: an explicit deletion never buries a project that still exists', () => {
  // A stale id in the pending set must not be able to delete a project that has
  // since been re-created, or the safety net becomes the hazard.
  const api = splitApi();
  const index = api.normIndex({ schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] });
  const live = legacyWorkbook([project('p1', [sheet('s1')])]);
  const next = api.indexAfter(index, live, live, AT, ['p1']);
  assert.equal(next.projects.find(p => p.id === 'p1')._deleted, undefined,
    'present in the result wins over any claim that it was deleted');
});

test('MB161-027: a junk id in the pending set cannot corrupt the index', () => {
  const api = splitApi();
  const index = api.normIndex({ schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] });
  const after = legacyWorkbook([project('p1', [sheet('s1')])]);
  const next = api.indexAfter(index, after, after, AT, ['', 'not a valid id!', '../escape']);
  assert.deepEqual(next.projects.map(p => p.id), ['p1'], 'nothing else was added');
});

test('MB1188-001: a Google link survives every split conversion', () => {
  // colorKey was carried through and googleLink was not, so a linked project
  // lost its spreadsheet id, tab map and checkpoints the moment it went through
  // split storage — on save, on assembly, on migration, on restart. The badge
  // disappeared, "Sync now" went with it, and an imported project looked like
  // it had vanished, because the thing that made it a Google project was gone.
  const api = splitApi();
  const link = {
    spreadsheetId: '1zZ4M7ewY7cFBePc2nV-kX2j-YHr0rilPQ6bFvB7WYrg',
    rows: 500, columns: 26,
    tabs: {
      s1: { title: 'Monday',  checkpoint: { '0,0': 'TIME' }, mergeSig: 'abc123' },
      s2: { title: 'Tuesday', checkpoint: { '0,0': 'TIME' } },
    },
  };
  const workbook = {
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'Color Block', activeId: 's1',
      sheets: [sheet('s1'), sheet('s2')],
      googleLink: link,
    }],
  };

  // Every individual conversion.
  const asDoc = api.projectAsDoc(workbook, 'p1');
  assert.deepEqual(asDoc.googleLink, link, '_ssProjectAsDoc');
  const backToWorkbook = api.docToWorkbook(asDoc);
  assert.deepEqual(backToWorkbook.projects[0].googleLink, link, '_ssProjectDocToWorkbook');
  const toDoc = api.workbookToDoc(backToWorkbook);
  assert.deepEqual(toDoc.googleLink, link, '_ssWorkbookToProjectDoc');

  // Through the normalizer a project document actually goes through on save.
  const normalized = api.normProject(asDoc);
  assert.deepEqual(normalized.googleLink, link, 'normalizeSpreadsheetProject');

  // And through assembly, which is what a restart does.
  const assembled = api.assemble(
    { schema: 2, activeProject: 'p1', projects: [{ id: 'p1', version: 1 }] },
    new Map([['spreadsheet_p1', normalized]]),
  );
  assert.deepEqual(assembled.projects[0].googleLink, link, '_ssAssembleWorkbook');
});

// ── MB1188-020: project-level state survives a save ─────────────────────────

function mergeApi() {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Math, TextEncoder,
    showToast() {},
    // Attribution needs to know who is typing; without these the stamping path
    // runs but records nobody, and the test reads as a merge bug.
    currentUser: () => 'Emma Minnetto',
    _ssMirroringFromGoogle: false,
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80,
        MAX_RESOLVED_CONFLICT_IDS = 200, MAX_SPREADSHEET_CONFLICTS = 200;
    ${declaration('_ssDigest')}
    ${declaration('_recordContentKey')}
    ${declaration('_conflictVariantKey')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    ${declaration('_ssCellSignature')}
    ${declaration('_ssConflictId')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssAttributionActor')}
    ${declaration('_ssStampAttribution')}
    ${declaration('_ssStructureDigest')}
    ${declaration('_ssStructureWasEditedRemotely')}
    ${declaration('_deriveSpreadsheetOperations')}
    ${declaration('_applySpreadsheetOperations')}
    ${declaration('_mergeSpreadsheetEdits')}
    globalThis.merge = (base, dirtyBase, dirty) =>
      JSON.parse(JSON.stringify(_mergeSpreadsheetEdits(base, dirtyBase, dirty)));
  `, context);
  return context.merge;
}

const keySheet = () => ({
  id: 's1', name: 'Sheet1', rows: 5, cols: 5,
  colWidths: [100, 100, 100, 100, 100], cells: { '0,0': { v: 'x', bg: '', tc: '', b: false } },
});
const keyBook = over => ({
  activeProject: 'p1',
  projects: [{ id: 'p1', name: 'Color Block', activeId: 's1', sheets: [keySheet()], ...over }],
});

test('MB1188-020: turning the colour key on survives the save', () => {
  // The merge rebuilds the workbook from the reconciled base and replays
  // operations. colorKey is not an operation, so it reverted to the base copy
  // every time — the toggle worked in memory and snapped shut on save.
  const merge = mergeApi();
  const off = { visible: false, entries: [{ bg: '#ffd966', tc: '#333333', label: 'Piano' }] };
  const on = { visible: true, entries: off.entries };
  const out = merge(keyBook({ colorKey: off }), keyBook({ colorKey: off }), keyBook({ colorKey: on }));
  assert.equal(out.projects[0].colorKey.visible, true, 'the key stays open');
});

test('MB1188-020: adding a key entry does not close the key', () => {
  // The reported symptom: pressing Add Entry made the whole key disappear,
  // because the save reverted colorKey wholesale — entry and visibility both.
  const merge = mergeApi();
  const before = { visible: true, entries: [{ bg: '#ffd966', tc: '#333333', label: 'Piano' }] };
  const after = {
    visible: true,
    entries: [...before.entries, { bg: '#ffffff', tc: '#333333', label: 'New Entry' }],
  };
  const out = merge(keyBook({ colorKey: before }), keyBook({ colorKey: before }), keyBook({ colorKey: after }));
  assert.equal(out.projects[0].colorKey.visible, true, 'still open');
  assert.equal(out.projects[0].colorKey.entries.length, 2, 'and the new entry is there');
  assert.equal(out.projects[0].colorKey.entries[1].label, 'New Entry');
});

test('MB1188-020: the colour key is per project, so it spans every tab', () => {
  // Stored on the project rather than the sheet, which is what makes it the
  // same key on all six tabs and the same key for whoever opens it next.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const get = source.slice(source.indexOf('function ssGetColorKey('));
  assert.match(get.slice(0, get.indexOf('\n}') + 2), /ssActiveProject\(\)/,
    'read from the project, never from the active sheet');
  assert.match(source, /\['id', 'name', 'activeId', 'sheets', 'colorKey', 'googleLink'\]/,
    'and carried on the project document, so it syncs to the other Macs');
});

test('MB1188-020: a Google link set locally is not reverted by the merge', () => {
  // Same defect, quieter symptom: a pull advances the checkpoint, the merge
  // hands back the base link, and the next sync redoes work already done.
  const merge = mergeApi();
  const before = { spreadsheetId: 'a'.repeat(30), rows: 200, columns: 30,
    tabs: { s1: { title: 'Thursday', checkpoint: { '0,0': 'old' } } } };
  const after = { ...before,
    tabs: { s1: { title: 'Thursday', checkpoint: { '0,0': 'new' } } } };
  const out = merge(keyBook({ googleLink: before }), keyBook({ googleLink: before }),
    keyBook({ googleLink: after }));
  assert.equal(out.projects[0].googleLink.tabs.s1.checkpoint['0,0'], 'new',
    'the advanced checkpoint is kept');
  // pulledAt is deliberately absent from shared state now — MB1188-026.
  assert.equal(out.projects[0].googleLink.pulledAt, undefined);
});

test('MB1188-020: a field this Mac did not touch is left to the merge', () => {
  // The rule is "this Mac changed it relative to what it started from", not
  // "this Mac wins" — otherwise every save would stamp its own stale copy over
  // whatever the other Mac had just done.
  const merge = mergeApi();
  const mine = { visible: false, entries: [{ bg: '#ffd966', tc: '#333333', label: 'Piano' }] };
  const theirs = { visible: true, entries: [{ bg: '#6aa84f', tc: '#ffffff', label: 'Guitar' }] };
  // base carries the other Mac's key; this Mac never touched its own copy.
  const out = merge(keyBook({ colorKey: theirs }), keyBook({ colorKey: mine }), keyBook({ colorKey: mine }));
  assert.deepEqual(JSON.parse(JSON.stringify(out.projects[0].colorKey)), theirs,
    "an untouched field keeps the other Mac's value");
});

// ── MB1188-021: the activity panel stops emptying itself ───────────────────

test('MB1188-021: an existing stamp is not destroyed by the next save', () => {
  // Reproduces what was seen on screen: Emma edits a cell and her name appears
  // in the panel; Carrie opens the same sheet seconds later, sees the edited
  // cell, and the panel says no edits have ever been tracked.
  //
  // The merge rebuilds each sheet from the durable base and only stamps cells
  // that have an operation, so every stamp this Mac held that the base did not
  // also hold was thrown away on the next save.
  const merge = mergeApi();
  const stamped = {
    id: 's1', name: 'Monday', rows: 5, cols: 5, colWidths: [100, 100, 100, 100, 100],
    cells: { '0,0': { v: 'old', bg: '', tc: '', b: false } },
    editedBy: { '0,0': { by: 'Elizabeth Chaves', at: '2026-08-07T20:00:00.000Z' } },
  };
  const withSheet = sheet => ({
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Color Block', activeId: 's1', sheets: [sheet] }],
  });
  // The durable base carries no stamps — a Google mirror save writes this way.
  const base = withSheet({ ...stamped, editedBy: undefined });
  const edited = {
    ...stamped,
    cells: { ...stamped.cells, '1,1': { v: 'new', bg: '', tc: '', b: false } },
  };
  const out = merge(base, withSheet(stamped), withSheet(edited));
  const kept = out.projects[0].sheets[0].editedBy || {};
  assert.ok(kept['0,0'], 'the earlier stamp survives the save');
  assert.equal(kept['0,0'].by, 'Elizabeth Chaves');
  assert.ok(kept['1,1'], 'and the new edit is stamped too');
});

test('MB1188-021: the other Mac’s stamps are kept, and the newer one wins', () => {
  const merge = mergeApi();
  const sheetWith = editedBy => ({
    id: 's1', name: 'Monday', rows: 5, cols: 5, colWidths: [100, 100, 100, 100, 100],
    cells: { '0,0': { v: 'x', bg: '', tc: '', b: false },
             '2,2': { v: 'y', bg: '', tc: '', b: false } },
    editedBy,
  });
  const withSheet = sheet => ({
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Color Block', activeId: 's1', sheets: [sheet] }],
  });
  // The base carries a stamp only the other Mac has; this Mac carries its own,
  // plus an older stamp on the same cell the base stamped later.
  const base = withSheet(sheetWith({
    '2,2': { by: 'Carrie Gass', at: '2026-08-07T21:00:00.000Z' },
    '0,0': { by: 'Carrie Gass', at: '2026-08-07T21:00:00.000Z' },
  }));
  const mine = withSheet(sheetWith({
    '0,0': { by: 'Emma Minnetto', at: '2026-08-07T20:00:00.000Z' },
  }));
  const out = merge(base, mine, mine);
  const kept = out.projects[0].sheets[0].editedBy || {};
  assert.equal(kept['2,2'].by, 'Carrie Gass', "the other Mac's stamp is kept");
  assert.equal(kept['0,0'].by, 'Carrie Gass', 'and the later stamp wins on a shared cell');
});

test('MB1188-021: a stamp for a cell that no longer exists is not resurrected', () => {
  // Carrying stamps forward must not undo the pruning that stops the map
  // growing forever as people clear and retype cells.
  const merge = mergeApi();
  const withSheet = (cells, editedBy) => ({
    activeProject: 'p1',
    projects: [{ id: 'p1', name: 'Color Block', activeId: 's1', sheets: [{
      id: 's1', name: 'Monday', rows: 5, cols: 5, colWidths: [100, 100, 100, 100, 100],
      cells, editedBy }] }],
  });
  const gone = { '9,9': { by: 'Elizabeth Chaves', at: '2026-08-07T20:00:00.000Z' } };
  const cells = { '0,0': { v: 'kept', bg: '', tc: '', b: false } };
  const merged = merge(withSheet(cells, undefined), withSheet(cells, gone), withSheet(cells, gone));
  // Pruning happens in the normalizer, which every save runs the merge through.
  const out = normalizeApi()(merged);
  const kept = out.projects[0].sheets[0].editedBy || {};
  assert.equal(kept['9,9'], undefined, 'a stamp with no cell behind it is dropped');
});

function normalizeApi() {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Math, TextEncoder,
    showToast() {},
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80,
        MAX_RESOLVED_CONFLICT_IDS = 200, MAX_SPREADSHEET_CONFLICTS = 200;
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    globalThis.norm = book => JSON.parse(JSON.stringify(normalizeSpreadsheetWorkbook(book)));
  `, context);
  return context.norm;
}

test('MB1188-023: an automatic Google check does not erase who edited a cell', () => {
  // The bug behind "the activity keeps disappearing a couple of minutes later".
  // A Google mirror save suppresses the actor on purpose, so its operations
  // carry no author — and an authorless operation used to DELETE the existing
  // stamp. Every automatic check erased the credit for exactly the cells
  // somebody had just typed, because those are the ones that differ from the
  // checkpoint and therefore produce an operation.
  const context = vm.createContext({ Object, Date, JSON, Number, String, Math, Array });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssStampAttribution')}
    globalThis.stamp = (sheet, target, op) => { _ssStampAttribution(sheet, target, op); return sheet; };
  `, context);

  const existing = () => ({
    editedBy: { '0,0': { by: 'Carrie Gass', at: '2026-08-07T21:50:00.000Z' } },
  });

  // A mirror write: the cell still has a value, but nobody to credit.
  const mirrored = context.stamp(existing(), '0,0',
    { value: { v: 'carrie test', bg: '', tc: '', b: false }, by: null, at: null });
  assert.ok(mirrored.editedBy?.['0,0'], 'the credit survives a system write');
  assert.equal(mirrored.editedBy['0,0'].by, 'Carrie Gass');

  // A real edit by someone else still takes it over.
  const taken = context.stamp(existing(), '0,0',
    { value: { v: 'ana test', bg: '', tc: '', b: false }, by: 'Ana Chaves', at: '2026-08-07T21:55:00.000Z' });
  assert.equal(taken.editedBy['0,0'].by, 'Ana Chaves', 'a real edit re-credits the cell');

  // Clearing the cell still drops the credit with it — that branch was correct.
  const cleared = context.stamp(existing(), '0,0', { value: null, by: null, at: null });
  assert.equal(cleared.editedBy, undefined, 'a cleared cell keeps no credit');
});

test('MB1188-023: a system write leaves other cells’ credits untouched too', () => {
  const context = vm.createContext({ Object, Date, JSON, Number, String, Math, Array });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssStampAttribution')}
    globalThis.stamp = (sheet, target, op) => { _ssStampAttribution(sheet, target, op); return sheet; };
  `, context);
  const sheet = {
    editedBy: {
      '0,0': { by: 'Megan', at: '2026-08-07T21:48:00.000Z' },
      '1,1': { by: 'Carrie Gass', at: '2026-08-07T21:53:00.000Z' },
    },
  };
  context.stamp(sheet, '1,1', { value: { v: 'x', bg: '', tc: '', b: false }, by: null, at: null });
  assert.equal(sheet.editedBy['0,0'].by, 'Megan', 'the older credit is still there');
  assert.equal(sheet.editedBy['1,1'].by, 'Carrie Gass',
    'and so is the one the mirror wrote over — which is the one that kept vanishing');
});

test('MB1188-024: typing something and deleting it is not counted as a change', () => {
  // Clearing a cell writes a blank record rather than removing the key, so the
  // operation's value is an empty cell object rather than null. That read as an
  // edit, and left you credited with a change to a cell holding nothing.
  const context = vm.createContext({ Object, Date, JSON, Number, String, Math, Array });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssStampAttribution')}
    globalThis.stamp = (sheet, target, op) => { _ssStampAttribution(sheet, target, op); return sheet; };
  `, context);
  const blank = { v: '', bg: '', tc: '', b: false };
  const at = '2026-08-07T21:55:00.000Z';

  // Type something: credited.
  const sheet = context.stamp({}, '0,0',
    { value: { v: 'oops', bg: '', tc: '', b: false }, by: 'Ana Chaves', at });
  assert.equal(sheet.editedBy['0,0'].by, 'Ana Chaves');

  // Delete it again: the credit goes with it.
  context.stamp(sheet, '0,0', { value: blank, by: 'Ana Chaves', at });
  assert.equal(sheet.editedBy, undefined, 'no credit for a cell that ends up empty');
});

test('MB1188-024: emptying one cell leaves the other credits alone', () => {
  const context = vm.createContext({ Object, Date, JSON, Number, String, Math, Array });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssStampAttribution')}
    globalThis.stamp = (sheet, target, op) => { _ssStampAttribution(sheet, target, op); return sheet; };
  `, context);
  const sheet = { editedBy: {
    '0,0': { by: 'Megan', at: '2026-08-07T21:48:00.000Z' },
    '1,1': { by: 'Ana Chaves', at: '2026-08-07T21:53:00.000Z' },
  } };
  context.stamp(sheet, '1,1',
    { value: { v: '', bg: '', tc: '', b: false }, by: 'Ana Chaves', at: '2026-08-07T21:55:00.000Z' });
  assert.equal(sheet.editedBy['1,1'], undefined, 'the emptied cell loses its credit');
  assert.equal(sheet.editedBy['0,0'].by, 'Megan', 'and nothing else is touched');
});

test('MB1188-024: a fill, or a blank merged cell, is still a real change', () => {
  // Emptying the TEXT is not the same as emptying the cell. Colouring a cell
  // with no text in it is a deliberate act on a schedule built out of colour,
  // and a merge span is structure rather than emptiness.
  const context = vm.createContext({ Object, Date, JSON, Number, String, Math, Array });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    ${declaration('_ssCellIsBlank')}
    ${declaration('_ssStampAttribution')}
    globalThis.stamp = (sheet, target, op) => { _ssStampAttribution(sheet, target, op); return sheet; };
  `, context);
  const at = '2026-08-07T21:55:00.000Z';
  const filled = context.stamp({}, '0,0',
    { value: { v: '', bg: '#ffd966', tc: '', b: false }, by: 'Ana Chaves', at });
  assert.ok(filled.editedBy?.['0,0'], 'a fill with no text is still a change');

  const merged = context.stamp({}, '1,1',
    { value: { v: '', bg: '', tc: '', b: false, rs: 2, cs: 1 }, by: 'Ana Chaves', at });
  assert.ok(merged.editedBy?.['1,1'], 'and so is a merge');
});

test('AUDIT: every field the normalizer keeps is handled by the merge', () => {
  // Three separate bugs this session had one shape: colorKey, googleLink and
  // editedBy were each kept by the normalizer, described by no operation, and
  // therefore silently reverted to the base copy on every save. The symptoms
  // were a colour key that snapped shut, a Google checkpoint that never
  // advanced, and an activity panel that emptied itself.
  //
  // This is the tripwire. A field added to either allowlist without a
  // corresponding decision in _mergeSpreadsheetEdits fails here rather than
  // being discovered weeks later as data quietly going missing.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const listOf = pattern => {
    const match = pattern.exec(source);
    assert.ok(match, `allowlist ${pattern} still exists`);
    return match[1].split(',').map(entry => entry.trim().replace(/^'|'$/g, ''));
  };
  const projectFields = listOf(/\['id', 'name', 'activeId', 'sheets', ([^\]]*)\]/);
  const sheetFields = listOf(/\['id', 'name', 'rows', 'cols', ([^\]]*)\]/);

  const merge = declaration('_mergeSpreadsheetEdits');
  for (const field of [...projectFields, ...sheetFields, 'activeId', 'rows', 'cols']) {
    if (!field || field === 'id' || field === 'name') continue;
    assert.ok(merge.includes(field),
      `_mergeSpreadsheetEdits says nothing about "${field}". Either carry it from ` +
      `the local copy the way colorKey and editedBy are, or make it an operation. ` +
      `A field the merge ignores reverts to the base on every save.`);
  }
});
