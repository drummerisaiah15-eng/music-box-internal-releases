// Behavioural tests for the two spreadsheet surfaces that had only ever been
// checked by matching against source text: conflict resolution (MB161-009) and
// the sheet activity window (MB161-010).
//
// Asserting that a function CONTAINS a line is not evidence the function works.
// That is precisely how the conflict-loss bug survived a passing suite for
// weeks. Everything here executes the real renderer code against a small DOM
// stand-in and looks at what it produced.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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

// ── A DOM small enough to reason about ───────────────────────────────────────
//
// Only what the two renderers actually touch. Deliberately not jsdom: the point
// is to see exactly which properties the code sets, and a full DOM would let a
// typo pass silently.

function makeElement(id = '') {
  const element = {
    id,
    tagName: 'DIV',
    type: '',
    title: '',
    onclick: null,
    children: [],
    attributes: new Map(),
    style: new Proxy({ cssText: '' }, {
      set(target, key, value) { target[key] = value; return true; },
    }),
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      contains(name) { return this._set.has(name); },
      toggle(name, on) { if (on) this.add(name); else this.remove(name); },
    },
    setAttribute(key, value) { element.attributes.set(key, String(value)); },
    getAttribute(key) { return element.attributes.has(key) ? element.attributes.get(key) : null; },
    removeAttribute(key) { element.attributes.delete(key); },
    appendChild(child) { element.children.push(child); return child; },
    querySelectorAll() { return []; },
  };
  let html = '';
  let text = '';
  Object.defineProperty(element, 'innerHTML', {
    get() { return html; },
    set(value) { html = String(value); element.children = []; },
  });
  Object.defineProperty(element, 'textContent', {
    get() {
      return element.children.length
        ? element.children.map(child => child.textContent).join('')
        : text;
    },
    set(value) { text = String(value); element.children = []; },
  });
  return element;
}

function makeDocument(ids) {
  const nodes = new Map(ids.map(id => [id, makeElement(id)]));
  return {
    nodes,
    getElementById: id => nodes.get(id) || null,
    createElement: tag => {
      const node = makeElement();
      node.tagName = String(tag).toUpperCase();
      return node;
    },
  };
}

// Flatten a rendered subtree into the visible strings, in order.
function visibleText(element) {
  if (!element.children.length) return element.textContent ? [element.textContent] : [];
  return element.children.flatMap(visibleText);
}

// ── Conflict resolution ──────────────────────────────────────────────────────

const cell = (v, extra = {}) => ({ v, bg: '', tc: '', b: false, ...extra });

function workbookWithConflict(conflicts, overrides = {}) {
  return {
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'Fall Schedule', activeId: 's1',
      sheets: [{
        id: 's1', name: 'Week 1', rows: 5, cols: 5, colWidths: [],
        cells: { '0,0': cell('WINNER'), '1,1': cell('other') },
      }],
    }],
    ...(conflicts ? { _conflicts: conflicts } : {}),
    ...overrides,
  };
}

const cellConflict = (over = {}) => ({
  id: 'sc_cell1', kind: 'cell', projectId: 'p1', sheetId: 's1', target: '0,0',
  base: cell('BASE'), local: cell('MINE'), remote: cell('THEIRS'),
  at: '2026-08-06T10:00:00.000Z', ...over,
});

function conflictApi(workbook, options = {}) {
  const saved = [];
  const toasts = [];
  const document = makeDocument([
    'ss-conflict-banner', 'ss-conflict-list', 'ss-conflict-modal', 'ss-editor-view',
  ]);
  document.getElementById('ss-editor-view').style.display = options.inEditor ? '' : 'none';

  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Promise, Error,
    document,
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
    showToast: message => toasts.push(message),
    ssRender: () => saved.push('render'),
    ssRenderHomeView: () => saved.push('home'),
    ssColLabel: c => String.fromCharCode(65 + Number(c)),
    escHtml: value => String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    safeCssColor: value => (/^#[0-9a-fA-F]{3,8}$/.test(String(value)) ? String(value) : 'transparent'),
    jsArg: value => JSON.stringify(String(value)),
    ssSave: async () => {
      if (options.failSave) throw new Error('disk full');
      saved.push('save');
      return true;
    },
  });

  vm.runInContext(`
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    var _ssBlockedWorkbook = null;
    var _ssAwaitingAuthority = false;
    var _ssSavePending = Promise.resolve(true);
    var _ssData = ${JSON.stringify(workbook)};
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_ssSheetOf')}
    ${declaration('_ssUnresolvedConflicts')}
    ${declaration('_ssConflictLocation')}
    ${declaration('_ssConflictValueHtml')}
    ${declaration('_ssConflictSideLabels')}
    ${declaration('ssRenderConflictBanner')}
    ${declaration('ssOpenConflicts')}
    ${declaration('ssCloseConflicts')}
    ${declaration('ssRenderConflictList')}
    ${declaration('_ssApplyConflictChoice')}
    ${declaration('ssResolveConflict')}
    globalThis.api = {
      data: () => _ssData,
      apply: (entry, choice) => _ssApplyConflictChoice(entry, choice),
      resolve: (id, choice) => ssResolveConflict(id, choice),
      renderList: () => ssRenderConflictList(),
      renderBanner: () => ssRenderConflictBanner(),
      open: () => ssOpenConflicts(),
    };
  `, context);

  return { api: context.api, document, saved, toasts };
}

test('MB161-009: a cell conflict resolves to whichever side was chosen', async () => {
  for (const [choice, expected] of [['local', 'MINE'], ['remote', 'THEIRS']]) {
    const { api, saved } = conflictApi(workbookWithConflict([cellConflict()]));
    assert.equal(await api.resolve('sc_cell1', choice), true);
    const data = api.data();
    assert.equal(data.projects[0].sheets[0].cells['0,0'].v, expected,
      `choosing ${choice} writes that value into the sheet`);
    assert.equal(data._conflicts, undefined, 'and the conflict is cleared');
    assert.deepEqual([...data._resolvedConflicts], ['sc_cell1'],
      'with a durable marker so a stale Mac cannot reattach it');
    assert.ok(saved.includes('save'), 'the decision went out through the save path');
  }
});

test('MB161-009: choosing the side that already won still clears the conflict', async () => {
  // The merge writes the winner into the sheet before anyone resolves anything.
  // Picking that same side produces no cell change at all — the marker is the
  // only thing that closes it, so it had better not depend on a write.
  const conflict = cellConflict({ local: cell('WINNER') });
  const { api } = conflictApi(workbookWithConflict([conflict]));
  assert.equal(await api.resolve('sc_cell1', 'local'), true);
  assert.equal(api.data().projects[0].sheets[0].cells['0,0'].v, 'WINNER');
  assert.equal(api.data()._conflicts, undefined, 'resolved despite nothing changing');
});

test('MB161-009: resolving to a null value clears the cell rather than storing null', async () => {
  const conflict = cellConflict({ local: null });
  const { api } = conflictApi(workbookWithConflict([conflict]));
  await api.resolve('sc_cell1', 'local');
  assert.equal('0,0' in api.data().projects[0].sheets[0].cells, false,
    'a cleared cell is absent, not a null record');
});

test('MB161-009: name conflicts resolve on both sides', async () => {
  for (const [kind, choice, expected] of [
    ['project-name', 'local', 'My Name'],
    ['project-name', 'remote', 'Their Name'],
    ['sheet-name', 'local', 'My Sheet'],
    ['sheet-name', 'remote', 'Their Sheet'],
  ]) {
    const isProject = kind === 'project-name';
    const entry = {
      id: 'sc_name', kind, projectId: 'p1', sheetId: isProject ? null : 's1',
      base: 'Base', at: '2026-08-06T10:00:00.000Z',
      local: isProject ? 'My Name' : 'My Sheet',
      remote: isProject ? 'Their Name' : 'Their Sheet',
    };
    const { api } = conflictApi(workbookWithConflict([entry]));
    assert.equal(await api.resolve('sc_name', choice), true);
    const target = isProject
      ? api.data().projects[0]
      : api.data().projects[0].sheets[0];
    assert.equal(target.name, expected, `${kind} / ${choice}`);
    assert.equal(api.data()._conflicts, undefined);
  }
});

test('MB161-009: a contested deletion can be confirmed or undone', async () => {
  const deletedSheet = { id: 's2', name: 'Week 2', rows: 3, cols: 3, colWidths: [], cells: { '0,0': cell('kept') } };
  const entry = {
    id: 'sc_sheet', kind: 'sheet', projectId: 'p1', sheetId: 's2',
    remote: deletedSheet, at: '2026-08-06T10:00:00.000Z',
  };

  const confirmed = conflictApi(workbookWithConflict([entry]));
  await confirmed.api.resolve('sc_sheet', 'local');
  assert.equal(confirmed.api.data().projects[0].sheets.length, 1,
    'keeping this Mac’s side leaves the sheet deleted');
  assert.equal(confirmed.api.data()._conflicts, undefined);

  const restored = conflictApi(workbookWithConflict([entry]));
  await restored.api.resolve('sc_sheet', 'remote');
  const sheets = restored.api.data().projects[0].sheets;
  assert.equal(sheets.length, 2, 'keeping theirs brings it back');
  assert.equal(sheets[1].cells['0,0'].v, 'kept', 'with the work that was in it');

  // The restore must be idempotent: a second click cannot duplicate the sheet.
  assert.equal(restored.api.apply(entry, 'remote'), true);
  assert.equal(restored.api.data().projects[0].sheets.length, 2, 'no duplicate');
});

test('MB161-009: a deleted project can be restored the same way', async () => {
  const deletedProject = {
    id: 'p2', name: 'Spring', activeId: 'sx',
    sheets: [{ id: 'sx', name: 'S', rows: 2, cols: 2, colWidths: [], cells: {} }],
  };
  const entry = {
    id: 'sc_proj', kind: 'project', projectId: 'p2',
    remote: deletedProject, at: '2026-08-06T10:00:00.000Z',
  };
  const { api } = conflictApi(workbookWithConflict([entry]));
  await api.resolve('sc_proj', 'remote');
  assert.equal(api.data().projects.length, 2);
  assert.equal(api.data().projects[1].name, 'Spring');
});

test('MB161-009: a conflict pointing at something deleted is cleared, not thrown on', async () => {
  const orphan = cellConflict({ id: 'sc_orphan', sheetId: 'gone' });
  const { api, toasts } = conflictApi(workbookWithConflict([orphan]));
  assert.equal(await api.resolve('sc_orphan', 'local'), true,
    'a stale conflict must not wedge the dialog');
  assert.equal(api.data()._conflicts, undefined, 'it is cleared');
  assert.ok(toasts.some(t => /no longer exists/.test(t)), 'and says why');
});

test('MB161-009: clicking a conflict that is already gone is a no-op', async () => {
  const { api, saved } = conflictApi(workbookWithConflict(null));
  assert.equal(await api.resolve('sc_nothing', 'local'), false);
  assert.equal(saved.includes('save'), false, 'nothing is written');
});

test('MB161-009: a refused save restores the conflict AND the value', async () => {
  // The failure mode that matters most. Deleting the conflict record and then
  // failing to save would destroy the only copy of the losing value — the
  // original bug, arrived at by a different route.
  const { api } = conflictApi(
    workbookWithConflict([cellConflict()]),
    { failSave: true },
  );
  assert.equal(await api.resolve('sc_cell1', 'remote'), false);
  const data = api.data();
  assert.equal(data._conflicts?.length, 1, 'the conflict record is back');
  assert.equal(data._conflicts[0].local.v, 'MINE', 'with both values intact');
  assert.equal(data._conflicts[0].remote.v, 'THEIRS');
  assert.equal(data.projects[0].sheets[0].cells['0,0'].v, 'WINNER',
    'and the sheet is unchanged');
  assert.equal(data._resolvedConflicts, undefined,
    'nothing is marked resolved when the decision did not persist');
});

test('MB161-009: resolving is refused entirely while the workbook is held', async () => {
  const { api } = conflictApi(workbookWithConflict([cellConflict()]));
  // The same gate every other edit path respects: no writing an invented
  // workbook while remote state is unknown.
  const resolve = declaration('ssResolveConflict');
  assert.match(resolve, /_ssBlockedWorkbook \|\| _ssAwaitingAuthority/);
  assert.equal(await api.resolve('sc_cell1', 'local'), true, 'and permitted when it is not');
});

test('MB161-009: the banner appears only when there is something to resolve', () => {
  const quiet = conflictApi(workbookWithConflict(null));
  quiet.api.renderBanner();
  assert.equal(quiet.document.getElementById('ss-conflict-banner').style.display, 'none');

  const busy = conflictApi(workbookWithConflict([cellConflict(), cellConflict({ id: 'sc_two' })]));
  busy.api.renderBanner();
  const banner = busy.document.getElementById('ss-conflict-banner');
  assert.equal(banner.style.display, '');
  assert.match(banner.innerHTML, /2 unresolved conflicts/);
  assert.match(banner.innerHTML, /Nothing has been lost/, 'and does not read as an error');

  const single = conflictApi(workbookWithConflict([cellConflict()]));
  single.api.renderBanner();
  assert.match(single.document.getElementById('ss-conflict-banner').innerHTML,
    /1 unresolved conflict</, 'singular');
});

test('MB161-009: the dialog shows where, when, both values and the common base', () => {
  const { api, document } = conflictApi(workbookWithConflict([cellConflict()]));
  api.renderList();
  const html = document.getElementById('ss-conflict-list').innerHTML;
  assert.match(html, /Fall Schedule/, 'the project');
  assert.match(html, /Week 1/, 'the sheet');
  assert.match(html, /A1/, 'the cell, in the notation the grid uses');
  assert.match(html, /MINE/, 'this Mac’s value');
  assert.match(html, /THEIRS/, 'the other Mac’s');
  assert.match(html, /Both were changed from: .*BASE/s, 'and what they diverged from');
  assert.match(html, /This Mac/);
  assert.match(html, /The other Mac/);
});

test('MB161-009: a contested deletion does not pretend to show a local value', () => {
  const entry = {
    id: 'sc_sheet', kind: 'sheet', projectId: 'p1', sheetId: 's2',
    remote: { id: 's2', name: 'Week 2', sheets: undefined },
    at: '2026-08-06T10:00:00.000Z',
  };
  const { api, document } = conflictApi(workbookWithConflict([entry]));
  api.renderList();
  const html = document.getElementById('ss-conflict-list').innerHTML;
  assert.match(html, /Deleted on this Mac/, 'the local act WAS the deletion');
  assert.match(html, /Restore it \(other Mac\)/);
  assert.doesNotMatch(html, /Both were changed from/,
    'there is no common base to show for a deletion');
});

test('MB161-009: an empty cell is described rather than rendered as blank', () => {
  const { api, document } = conflictApi(workbookWithConflict([
    cellConflict({ local: null, remote: cell('') }),
  ]));
  api.renderList();
  const html = document.getElementById('ss-conflict-list').innerHTML;
  assert.match(html, /\(empty\)/, 'a cleared cell');
  assert.match(html, /\(no text\)/, 'a cell with only formatting');
});

test('MB161-009: hostile content in a cell or a name cannot escape into the dialog', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const workbook = workbookWithConflict([cellConflict({
    local: cell(hostile), remote: cell('safe'), base: cell('b'),
  })]);
  workbook.projects[0].name = hostile;
  workbook.projects[0].sheets[0].name = `"><script>bad()</script>`;

  const { api, document } = conflictApi(workbook);
  api.renderList();
  const html = document.getElementById('ss-conflict-list').innerHTML;
  assert.doesNotMatch(html, /<img/, 'the cell value is escaped');
  assert.doesNotMatch(html, /<script>/, 'and so is the sheet name');
  assert.match(html, /&lt;img/, 'it is shown, just inertly');

  // The fill colour goes into a style attribute, which escaping does not cover.
  const injected = conflictApi(workbookWithConflict([cellConflict({
    local: cell('x', { bg: 'red;background:url(javascript:bad())' }),
  })]));
  injected.api.renderList();
  const styled = injected.document.getElementById('ss-conflict-list').innerHTML;
  assert.doesNotMatch(styled, /javascript:/, 'a fill colour is filtered, not trusted');
});

test('MB161-009: resolving the last conflict closes the dialog and says so', async () => {
  const { api, document, toasts } = conflictApi(workbookWithConflict([cellConflict()]));
  api.open();
  assert.equal(document.getElementById('ss-conflict-modal').classList.contains('hidden'), false);
  await api.resolve('sc_cell1', 'local');
  assert.equal(document.getElementById('ss-conflict-modal').classList.contains('hidden'), true);
  assert.ok(toasts.some(t => /All spreadsheet conflicts resolved/.test(t)));
});

test('MB161-009: resolving one of several leaves the dialog open on the rest', async () => {
  const { api, document } = conflictApi(workbookWithConflict([
    cellConflict(), cellConflict({ id: 'sc_two', target: '1,1' }),
  ]));
  api.open();
  await api.resolve('sc_cell1', 'local');
  assert.equal(document.getElementById('ss-conflict-modal').classList.contains('hidden'), false,
    'there is still work to do');
  assert.equal(api.data()._conflicts.length, 1);
  assert.match(document.getElementById('ss-conflict-list').innerHTML, /B2/,
    'and the list now shows the remaining one');
});

// ── The full loop: merge → normalize → resolve → merge again ─────────────────

function roundTripApi() {
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, BigInt, TextEncoder,
    showToast: () => {},
    _cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`
    var MAX_SPREADSHEET_CONFLICTS = 200;
    var MAX_RESOLVED_CONFLICT_IDS = 200;
    var MAX_SPREADSHEET_CELL_CHARS = 50000, MAX_SPREADSHEET_SHEETS = 25,
        MAX_SPREADSHEET_ROWS = 500, MAX_SPREADSHEET_COLS = 100,
        MAX_SPREADSHEET_GRID_CELLS = 10000, MAX_SPREADSHEET_TOTAL_CELLS = 10000,
        MAX_SPREADSHEET_TOTAL_CHARS = 400000, MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000,
        MAX_SPREADSHEET_ATTRIBUTIONS = 200, MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    var currentUser = () => 'Carrie';
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
    ${declaration('_mergeResolvedConflictIds')}
    ${declaration('_mergeSpreadsheetEdits')}
    ${declaration('_ssOversizeError')}
    ${declaration('_normalizeSpreadsheetAttribution')}
    ${declaration('normalizeSpreadsheetWorkbook')}
    globalThis.api = {
      merge: (base, dirtyBase, dirty) => _mergeSpreadsheetEdits(base, dirtyBase, dirty),
      norm: value => normalizeSpreadsheetWorkbook(value),
    };
  `, context);
  return {
    merge: (a, b, c) => JSON.parse(JSON.stringify(context.api.merge(a, b, c))),
    norm: v => JSON.parse(JSON.stringify(context.api.norm(v))),
  };
}

const book = cells => ({
  activeProject: 'p1',
  projects: [{
    id: 'p1', name: 'P', activeId: 's1',
    sheets: [{ id: 's1', name: 'S', rows: 3, cols: 3, colWidths: [], cells }],
  }],
});

test('MB161-009: a real conflict survives the save it is created by', () => {
  const { merge, norm } = roundTripApi();
  const base = book({ '0,0': cell('BASE') });
  const remote = book({ '0,0': cell('THEIRS') });
  const local = book({ '0,0': cell('MINE') });

  const merged = merge(remote, base, local);
  assert.equal(merged._conflicts.length, 1, 'the merge raises it');

  // The step that used to destroy it. The entry the merge actually produces
  // must satisfy the normalizer's own validation, not just a synthetic one.
  const normalized = norm(merged);
  assert.equal(normalized._conflicts.length, 1, 'and normalization keeps it');
  assert.equal(normalized._conflicts[0].local.v, 'MINE');
  assert.equal(normalized._conflicts[0].remote.v, 'THEIRS');
  assert.equal(normalized._conflicts[0].base.v, 'BASE');

  // Saving repeatedly must be stable — that is what typing actually does.
  assert.equal(norm(norm(normalized))._conflicts.length, 1);
});

test('MB161-009: a resolved conflict stays resolved through save and re-merge', () => {
  const { merge, norm } = roundTripApi();
  const base = book({ '0,0': cell('BASE') });
  const merged = merge(book({ '0,0': cell('THEIRS') }), base, book({ '0,0': cell('MINE') }));
  const id = merged._conflicts[0].id;

  // What ssResolveConflict does, then what the save path does with it.
  const decided = JSON.parse(JSON.stringify(merged));
  decided.projects[0].sheets[0].cells['0,0'] = cell('MINE');
  delete decided._conflicts;
  decided._resolvedConflicts = [id];

  const afterSave = norm(merge(merged, merged, decided));
  assert.equal(afterSave._conflicts, undefined, 'gone');
  assert.deepEqual([...afterSave._resolvedConflicts], [id], 'and recorded');

  // A Mac that was offline through all of that still holds the conflict.
  const stale = JSON.parse(JSON.stringify(merged));
  const reconciled = norm(merge(afterSave, stale, stale));
  assert.equal(reconciled._conflicts, undefined,
    'a stale peer cannot reattach a decision somebody already made');
});

test('MB161-009: structure conflicts the merge produces also survive normalization', () => {
  const { merge, norm } = roundTripApi();
  const base = book({ '0,0': cell('BASE') });
  base.projects[0].sheets.push({ id: 's2', name: 'S2', rows: 3, cols: 3, colWidths: [], cells: {} });

  // The other Mac edited s2; this Mac deleted it.
  const remote = JSON.parse(JSON.stringify(base));
  remote.projects[0].sheets[1].cells['0,0'] = cell('THEIR WORK');
  const local = JSON.parse(JSON.stringify(base));
  local.projects[0].sheets = [local.projects[0].sheets[0]];

  const merged = merge(remote, base, local);
  assert.equal(merged._conflicts.length, 1, 'a contested deletion is a conflict');
  assert.equal(merged._conflicts[0].kind, 'sheet');
  const normalized = norm(merged);
  assert.equal(normalized._conflicts.length, 1, 'and it is not stripped as malformed');
  assert.equal(normalized._conflicts[0].remote.cells['0,0'].v, 'THEIR WORK',
    'carrying the work that would otherwise be gone');
});

test('MB161-009: a conflict id written by an older build is still accepted', () => {
  // Ids widened from 32-bit djb2 to 64-bit FNV-1a. Anything already stored has
  // a short id, and refusing it would delete exactly the records this whole
  // change exists to protect.
  const { norm } = roundTripApi();
  const legacy = book({ '0,0': cell('x') });
  legacy._conflicts = [{
    id: 'sc_1a2b3c', kind: 'cell', projectId: 'p1', sheetId: 's1', target: '0,0',
    base: null, local: cell('old'), remote: cell('older'), at: '2026-07-01T00:00:00.000Z',
  }];
  assert.equal(norm(legacy)._conflicts.length, 1, 'an old short id survives');
  assert.equal(norm(legacy)._conflicts[0].local.v, 'old');
});

test('MB161-009: two Macs resolving different conflicts keep both decisions', () => {
  const { merge, norm } = roundTripApi();
  const base = book({ '0,0': cell('BASE A'), '0,1': cell('BASE B') });
  const remote = book({ '0,0': cell('THEIRS A'), '0,1': cell('THEIRS B') });
  const local = book({ '0,0': cell('MINE A'), '0,1': cell('MINE B') });

  const both = merge(remote, base, local);
  assert.equal(both._conflicts.length, 2);
  const [first, second] = both._conflicts.map(c => c.id);

  // Mac A settles one and syncs.
  const macA = JSON.parse(JSON.stringify(both));
  macA._conflicts = macA._conflicts.filter(c => c.id !== first);
  macA._resolvedConflicts = [first];
  const published = norm(merge(both, both, macA));

  // Mac B was offline and settled the other against the pre-sync copy.
  const macB = JSON.parse(JSON.stringify(both));
  macB._conflicts = macB._conflicts.filter(c => c.id !== second);
  macB._resolvedConflicts = [second];

  // B rebases onto what A published: both decisions must survive, and neither
  // conflict may reappear.
  const converged = norm(merge(published, both, macB));
  assert.equal(converged._conflicts, undefined, 'nothing is left outstanding');
  assert.deepEqual([...converged._resolvedConflicts].sort(), [first, second].sort(),
    'both decisions are recorded');
});

test('MB161-009: an unresolved conflict is never lost to somebody else’s resolution', () => {
  const { merge, norm } = roundTripApi();
  const base = book({ '0,0': cell('BASE A'), '0,1': cell('BASE B') });
  const both = merge(
    book({ '0,0': cell('THEIRS A'), '0,1': cell('THEIRS B') }),
    base,
    book({ '0,0': cell('MINE A'), '0,1': cell('MINE B') }),
  );
  const settledId = both._conflicts[0].id;
  const openId = both._conflicts[1].id;

  const decided = JSON.parse(JSON.stringify(both));
  decided._conflicts = decided._conflicts.filter(c => c.id !== settledId);
  decided._resolvedConflicts = [settledId];

  const after = norm(merge(both, both, decided));
  assert.equal(after._conflicts.length, 1, 'the other one is still there');
  assert.equal(after._conflicts[0].id, openId, 'and it is the right one');
});

test('MB161-009: being over the size limit says how to get back under it', () => {
  const { norm } = roundTripApi();
  const fat = book({ '0,0': cell('x') });
  // Conflicts big enough to blow the budget on their own.
  fat._conflicts = Array.from({ length: 40 }, (_, i) => ({
    id: 'sc_big' + i, kind: 'cell', projectId: 'p1', sheetId: 's1', target: '0,0',
    base: null, local: cell('m'.repeat(9000)), remote: cell('t'.repeat(9000)),
    at: '2026-08-06T10:00:00.000Z',
  }));
  assert.throws(() => norm(fat), /holding 40 unresolved conflicts/,
    'the message names the actual cause');
  assert.throws(() => norm(fat), /Resolve them on the Spreadsheets page/,
    'and the way out — resolving strictly shrinks the workbook');

  // A workbook that is simply too big still gets the plain message.
  const huge = book(Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`0,${i}`, cell('y'.repeat(2000))]),
  ));
  assert.throws(() => norm(huge), /exceeds the 600 KB sync limit/);
});

test('MB161-009: resolving is what gets a full workbook back under the limit', () => {
  const { norm } = roundTripApi();
  const near = book({ '0,0': cell('x') });
  // 33 conflicts is just over the ceiling; 32 is just under. The margin is the
  // point: settling ONE has to be enough, or there is no way out.
  near._conflicts = Array.from({ length: 33 }, (_, i) => ({
    id: 'sc_big' + i, kind: 'cell', projectId: 'p1', sheetId: 's1', target: '0,0',
    base: null, local: cell('m'.repeat(9000)), remote: cell('t'.repeat(9000)),
    at: '2026-08-06T10:00:00.000Z',
  }));
  assert.throws(() => norm(near), /600 KB/, 'over the line');
  near._conflicts = near._conflicts.slice(1);
  near._resolvedConflicts = ['sc_big0'];
  assert.doesNotThrow(() => norm(near),
    'settling one is enough to save again — the deadlock has an exit');
});

// ── The activity window ──────────────────────────────────────────────────────

function activityBarApi(sheet, storedWindow) {
  const store = new Map();
  if (storedWindow !== undefined) store.set('tmb__ss_activity_window', storedWindow);
  const document = makeDocument([
    'ss-activity-bar', 'ss-cell-attribution', 'ss-contributors',
  ]);
  const painted = [];
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean,
    document,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    ssActiveSheet: () => sheet,
    ssKey: (r, c) => `${r},${c}`,
    ssColLabel: c => String.fromCharCode(65 + Number(c)),
    _ssPresenceColor: () => '#3b82f6',
    _ssApplyActivityPanelState: () => {},
    _ssPaintContributorHighlight: () => painted.push('paint'),
  });
  vm.runInContext(`
    var _ssSelR = 0, _ssSelC = 0;
    var _ssHighlightedContributor = null;
    ${declaration('_ssRelativeTime')}
    ${declaration('_ssActivityWindow')}
    ${declaration('_ssActivityWindowStart')}
    ${declaration('_ssContributorSummary')}
    ${declaration('ssSetActivityWindow')}
    ${declaration('ssRenderActivityBar')}
    globalThis.api = {
      render: () => ssRenderActivityBar(),
      set: w => ssSetActivityWindow(w),
      window: () => _ssActivityWindow(),
      highlight: name => { _ssHighlightedContributor = name; },
      highlighted: () => _ssHighlightedContributor,
      select: (r, c) => { _ssSelR = r; _ssSelC = c; },
    };
  `, context);
  return { api: context.api, document, painted };
}

const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();

const busySheet = () => ({
  id: 's1',
  editedBy: {
    '0,0': { by: 'Carrie', at: hoursAgo(1) },
    '0,1': { by: 'Carrie', at: hoursAgo(2) },
    '0,2': { by: 'Carrie', at: hoursAgo(72) },
    '0,3': { by: 'Carrie', at: hoursAgo(24 * 40) },
    '0,4': { by: 'Elizabeth', at: hoursAgo(24 * 30) },
  },
});

test('MB161-010: the panel renders a switcher with the stored window active', () => {
  const { api, document } = activityBarApi(busySheet(), 'week');
  api.render();
  const chips = document.getElementById('ss-contributors').children;
  const switcher = chips[0];
  assert.equal(switcher.children.length, 3, 'Today / 7 days / All');
  assert.deepEqual(switcher.children.map(b => b.textContent), ['Today', '7 days', 'All']);
  const active = switcher.children.filter(b => /background:var\(--sidebar-accent\)/.test(b.style.cssText));
  assert.equal(active.length, 1, 'exactly one is active');
  assert.equal(active[0].textContent, '7 days', 'the one that was stored');
});

test('MB161-010: the count on a chip is the count for the window', () => {
  const today = activityBarApi(busySheet(), 'today');
  today.api.render();
  const todayText = visibleText(today.document.getElementById('ss-contributors')).join(' | ');
  assert.match(todayText, /Carrie/);
  assert.match(todayText, /2 changes/, 'only what happened since midnight');
  assert.doesNotMatch(todayText, /Elizabeth/, 'who has not been here in a month');

  const week = activityBarApi(busySheet(), 'week');
  week.api.render();
  assert.match(visibleText(week.document.getElementById('ss-contributors')).join(' | '),
    /3 changes/, 'seven days reaches further back');

  const all = activityBarApi(busySheet(), 'all');
  all.api.render();
  const allText = visibleText(all.document.getElementById('ss-contributors')).join(' | ');
  assert.match(allText, /4 changes/, 'All is the old running total');
  assert.match(allText, /Elizabeth/);
});

test('MB161-010: a single change is not "1 changes"', () => {
  const { api, document } = activityBarApi({
    id: 's1', editedBy: { '0,0': { by: 'Carrie', at: hoursAgo(1) } },
  }, 'today');
  api.render();
  const text = visibleText(document.getElementById('ss-contributors')).join(' | ');
  assert.match(text, /1 change ·/);
  assert.doesNotMatch(text, /1 changes/);
});

test('MB161-010: a quiet day reads differently from an untracked sheet', () => {
  const quietToday = activityBarApi(busySheet(), 'today');
  // Move every stamp out of today.
  const sheet = busySheet();
  for (const key of Object.keys(sheet.editedBy)) sheet.editedBy[key].at = hoursAgo(24 * 10);
  const stale = activityBarApi(sheet, 'today');
  stale.api.render();
  assert.match(visibleText(stale.document.getElementById('ss-contributors')).join(' '),
    /No edits today — switch to All/,
    'there IS history, it is just not from today');

  const virgin = activityBarApi({ id: 's1', editedBy: {} }, 'today');
  virgin.api.render();
  assert.match(visibleText(virgin.document.getElementById('ss-contributors')).join(' '),
    /No tracked edits on this sheet yet/,
    'nothing has ever been recorded — switching window will not help');
  quietToday.api.render();
});

test('MB161-010: switching the window re-renders and repaints', () => {
  const { api, document, painted } = activityBarApi(busySheet(), 'all');
  api.render();
  api.set('today');
  assert.equal(api.window(), 'today', 'the choice is stored');
  assert.ok(painted.length, 'the grid highlight is repainted, not left stale');
  assert.match(visibleText(document.getElementById('ss-contributors')).join(' | '), /2 changes/);
});

test('MB161-010: narrowing the window clears a highlight that no longer applies', () => {
  const { api } = activityBarApi(busySheet(), 'all');
  api.highlight('Elizabeth');           // last active a month ago
  api.set('today');
  assert.equal(api.highlighted(), null,
    'otherwise the whole grid dims and nothing lights up');

  const kept = activityBarApi(busySheet(), 'all');
  kept.api.highlight('Carrie');         // active an hour ago
  kept.api.set('today');
  assert.equal(kept.api.highlighted(), 'Carrie', 'someone still in the window is kept');
});

test('MB161-010: a junk stored window falls back rather than rendering nothing', () => {
  const { api, document } = activityBarApi(busySheet(), 'last-tuesday');
  api.render();
  assert.equal(api.window(), 'today');
  const switcher = document.getElementById('ss-contributors').children[0];
  assert.equal(switcher.children.filter(b => /sidebar-accent/.test(b.style.cssText))[0].textContent,
    'Today');
  api.set('nonsense');
  assert.equal(api.window(), 'today', 'and an invalid choice is ignored');
});

test('MB161-010: the selected cell still names who changed it, whatever the window', () => {
  const sheet = busySheet();
  const { api, document } = activityBarApi(sheet, 'today');
  api.select(0, 3);                       // stamped 40 days ago
  api.render();
  const line = document.getElementById('ss-cell-attribution').textContent;
  assert.match(line, /^D1 — Carrie, /, 'the per-cell record is not windowed');

  api.select(2, 2);                       // never touched
  api.render();
  assert.equal(document.getElementById('ss-cell-attribution').textContent, '',
    'and an untouched cell says nothing rather than guessing');
});

test('MB161-010: a profile name is rendered as text, never as markup', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const { api, document } = activityBarApi({
    id: 's1', editedBy: { '0,0': { by: hostile, at: hoursAgo(1) } },
  }, 'today');
  api.render();
  const contributors = document.getElementById('ss-contributors');
  assert.equal(contributors.innerHTML, '', 'the chips are nodes, not a markup string');
  assert.ok(visibleText(contributors).includes(hostile),
    'the name is shown verbatim as text, which is exactly what makes it safe');
});

test('MB161-010: rendering does not mutate the sheet', () => {
  const sheet = busySheet();
  const before = JSON.stringify(sheet);
  const { api } = activityBarApi(sheet, 'today');
  api.render();
  api.set('week');
  api.set('all');
  api.set('today');
  assert.equal(JSON.stringify(sheet), before,
    'the window is a read filter; no stamp is written or removed');
});

// ── MB161-008: the dashboard's "most recent log" ─────────────────────────────
//
// The reported symptom was visual — a new log appeared, was replaced by an
// older one, then came back. The merge is covered elsewhere; this runs the
// renderer that people actually looked at.

function logRenderApi(logs) {
  const document = makeDocument(['yesterday-log-content']);
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean,
    document,
    escHtml: value => String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    getVisibleLogs: () => JSON.parse(JSON.stringify(logs)),
  });
  vm.runInContext(`
    ${declaration('_syncRecordOrderKey')}
    ${declaration('_compareSyncRecords')}
    ${declaration('renderYesterdayLog')}
    globalThis.api = { render: () => renderYesterdayLog() };
  `, context);
  return { api: context.api, document };
}

const logEntry = (id, date, created, body, author = 'Carrie') =>
  ({ id, date, created, body, author, version: 1 });

test('MB161-008: the dashboard shows the newest entry regardless of array order', () => {
  const morning = logEntry('zzz', '2026-08-06', '2026-08-06T14:00:00.000Z', 'MORNING');
  const evening = logEntry('aaa', '2026-08-06', '2026-08-06T21:30:00.000Z', 'EVENING');
  const older = logEntry('mmm', '2026-08-05', '2026-08-05T20:00:00.000Z', 'YESTERDAY');

  // Every order the merge could hand over. Under the old date-only sort the
  // first two of these rendered different entries, which is exactly the flicker
  // that was reported.
  for (const order of [
    [morning, evening, older],
    [evening, morning, older],
    [older, morning, evening],
    [older, evening, morning],
  ]) {
    const { api, document } = logRenderApi(order);
    api.render();
    const html = document.getElementById('yesterday-log-content').innerHTML;
    assert.match(html, /EVENING/, `newest wins for order ${order.map(l => l.id).join(',')}`);
    assert.doesNotMatch(html, /MORNING/);
    assert.doesNotMatch(html, /YESTERDAY/);
  }
});

test('MB161-008: an entry whose id sorts high does not outrank a later one', () => {
  // Record ids are random by design (MB161-007), so id order says nothing about
  // time. Sorting by id after date would pick the wrong entry here.
  const { api, document } = logRenderApi([
    logEntry('zzzz', '2026-08-06', '2026-08-06T09:00:00.000Z', 'EARLY'),
    logEntry('aaaa', '2026-08-06', '2026-08-06T18:00:00.000Z', 'LATE'),
  ]);
  api.render();
  assert.match(document.getElementById('yesterday-log-content').innerHTML, /LATE/);
});

test('MB161-008: an entry with no creation time still ranks below one that has it', () => {
  const { api, document } = logRenderApi([
    { id: 'a', date: '2026-08-06', body: 'NO CREATED', author: 'X' },
    logEntry('b', '2026-08-06', '2026-08-06T08:00:00.000Z', 'HAS CREATED'),
  ]);
  api.render();
  assert.match(document.getElementById('yesterday-log-content').innerHTML, /HAS CREATED/,
    'a dated, timed entry is better evidence than an undated one');
});

test('MB161-008: no logs at all is an invitation, not a blank card', () => {
  const { api, document } = logRenderApi([]);
  api.render();
  assert.match(document.getElementById('yesterday-log-content').innerHTML,
    /No log entries yet/);
});

test('MB161-008: log content is escaped on the dashboard', () => {
  const { api, document } = logRenderApi([
    logEntry('a', '2026-08-06', '2026-08-06T09:00:00.000Z',
      '<img src=x onerror="alert(1)">', '<script>bad()</script>'),
  ]);
  api.render();
  const html = document.getElementById('yesterday-log-content').innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, /&lt;img/);
});

test('MB161-008: the dashboard does not reorder the caller’s array', () => {
  const logs = [
    logEntry('a', '2026-08-05', '2026-08-05T09:00:00.000Z', 'OLD'),
    logEntry('b', '2026-08-06', '2026-08-06T09:00:00.000Z', 'NEW'),
  ];
  const before = logs.map(l => l.id).join(',');
  const { api } = logRenderApi(logs);
  api.render();
  assert.equal(logs.map(l => l.id).join(','), before,
    'renderYesterdayLog sorts a copy — sorting in place would be a mutation '
    + 'of whatever getVisibleLogs handed back');
});

// ── MB161-011: the capacity ceiling ──────────────────────────────────────────
//
// The whole workbook is one Firestore document and Firestore caps a document at
// 1 MiB — a hard limit on every plan, with no documented way to raise it. That
// used to be discovered at SAVE time: staff typed all afternoon, then got
// "Spreadsheet changes were not saved" and were dropped to the project list.

function capacityApi(workbook) {
  const toasts = [];
  const document = makeDocument(['ss-capacity-notice']);
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    Date, Object, Map, Set, Array, JSON, Number, String, Boolean, Math, TextEncoder,
    document,
    showToast: (message, kind) => toasts.push({ message, kind }),
    escHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  });
  vm.runInContext(`
    var MAX_SPREADSHEET_TOTAL_CELLS = 10000;
    var MAX_SPREADSHEET_TOTAL_CHARS = 400000;
    var MAX_SPREADSHEET_SYNC_JSON_BYTES = 600000;
    var _ssData = ${JSON.stringify(workbook)};
    // MB161-012: capacity is per project once storage is split. These fixtures
    // exercise the legacy (workbook-wide) path, which is what an un-migrated
    // Mac still sees.
    function _ssStorageMode() { return 'legacy'; }
    function _ssProjectAsDoc() { return null; }
    ${declaration('_ssCapacity')}
    ${declaration('_ssCapacityRefusal')}
    ${declaration('ssRefuseIfFull')}
    ${declaration('ssRenderCapacityNotice')}
    globalThis.api = {
      capacity: () => _ssCapacity(_ssData),
      refusal: extra => _ssCapacityRefusal(_ssData, extra),
      refuse: extra => ssRefuseIfFull(extra),
      notice: () => ssRenderCapacityNotice(),
    };
  `, context);
  return { api: context.api, document, toasts };
}

// A workbook holding `n` filled cells of `chars` characters each.
function sizedWorkbook(n, chars = 12) {
  const cells = {};
  for (let i = 0; i < n; i += 1) {
    cells[`${Math.floor(i / 100)},${i % 100}`] = {
      v: 'x'.repeat(chars), bg: '', tc: '', b: false,
    };
  }
  return {
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'P', activeId: 's1',
      sheets: [{ id: 's1', name: 'S', rows: 200, cols: 100, colWidths: [], cells }],
    }],
  };
}

test('MB161-011: capacity counts filled cells, characters and encoded size', () => {
  const { api } = capacityApi(sizedWorkbook(500, 10));
  const capacity = api.capacity();
  assert.equal(capacity.cells.used, 500, 'only cells that hold something');
  assert.equal(capacity.characters.used, 5000);
  assert.ok(capacity.bytes.used > 5000, 'bytes include the structure, not just the text');
  assert.ok(capacity.fraction > 0 && capacity.fraction < 1);
});

test('MB161-011: an empty grid position costs nothing', () => {
  const wide = sizedWorkbook(10, 5);
  wide.projects[0].sheets[0].rows = 500;
  wide.projects[0].sheets[0].cols = 100;   // 50,000 grid positions, 10 filled
  const { api } = capacityApi(wide);
  assert.equal(api.capacity().cells.used, 10,
    'a big empty sheet is not a full workbook');
});

test('MB161-011: the reported measure is the tightest one, not the roomiest', () => {
  // Few cells, enormous text: quoting the cell count would be true and useless.
  const { api } = capacityApi(sizedWorkbook(100, 3800));
  const capacity = api.capacity();
  assert.equal(capacity.tightest.label, 'characters');
  assert.ok(capacity.fraction > 0.9);

  const many = capacityApi(sizedWorkbook(9800, 1)).api.capacity();
  assert.equal(many.tightest.label, 'cells');
});

test('MB161-011: a change that fits is not refused', () => {
  const { api, toasts } = capacityApi(sizedWorkbook(100, 10));
  assert.equal(api.refusal({ cells: 1, characters: 20, bytes: 80 }), null);
  assert.equal(api.refuse({ cells: 1, characters: 20, bytes: 80 }), false);
  assert.equal(toasts.length, 0, 'and says nothing about it');
});

test('MB161-011: a change that would not fit is refused with real numbers', () => {
  const { api, toasts } = capacityApi(sizedWorkbook(9990, 5));
  const refusal = api.refusal({ cells: 20, characters: 100, bytes: 900 });
  assert.match(refusal, /10,010 filled cells against a limit of 10,000/,
    'the actual figures, not "too large"');
  assert.match(refusal, /Nothing has been lost/, 'and does not read as data loss');
  assert.match(refusal, /delete or export a project/, 'with something to actually do');

  assert.equal(api.refuse({ cells: 20, characters: 100, bytes: 900 }), true);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'warning', 'a warning, not a danger — nothing broke');
});

test('MB161-011: each limit is reported in its own units', () => {
  assert.match(capacityApi(sizedWorkbook(100, 3900)).api.refusal({ characters: 50000 }),
    /characters against a limit of 400,000/);
  assert.match(capacityApi(sizedWorkbook(9000, 40)).api.refusal({ bytes: 400000 }),
    /\d+ KB against a limit of \d+ KB/, 'bytes are shown as KB, which is how people think');
});

test('MB161-011: the notice stays quiet until it is worth reading', () => {
  const quiet = capacityApi(sizedWorkbook(1000, 10));
  quiet.api.notice();
  assert.equal(quiet.document.getElementById('ss-capacity-notice').style.display, 'none',
    'a 10% full workbook is not news');

  const loud = capacityApi(sizedWorkbook(8000, 10));
  loud.api.notice();
  const notice = loud.document.getElementById('ss-capacity-notice');
  assert.equal(notice.style.display, '');
  assert.match(notice.innerHTML, /80% full/);
  assert.match(notice.innerHTML, /8,000 of 10,000 cells/, 'in the tightest measure');
  assert.match(notice.innerHTML, /Everything still syncs/, 'and is not alarming yet');
});

test('MB161-011: at the wall the notice changes tone and says what happens next', () => {
  const { api, document } = capacityApi(sizedWorkbook(9800, 10));
  api.notice();
  const notice = document.getElementById('ss-capacity-notice');
  assert.equal(notice.className, 'ss-capacity-critical');
  assert.match(notice.innerHTML, /98% full/);
  assert.match(notice.innerHTML, /Further edits will be refused/);
  assert.match(notice.innerHTML, /Nothing already saved is at risk/,
    'the distinction that actually matters to somebody looking at this');
});

test('MB161-011: the guard never blocks a change that shrinks the workbook', () => {
  // Deleting is the way out. A capacity check that refuses deletions would be
  // a trap with no exit.
  const { api } = capacityApi(sizedWorkbook(10000, 39));
  assert.ok(api.capacity().fraction >= 1, 'this workbook is at the ceiling');
  assert.equal(api.refusal({}), null, 'no change at all is always allowed');
  assert.equal(api.refusal({ cells: 0, characters: 0, bytes: 0 }), null);

  // And a workbook that is already OVER — imported by an older build, or synced
  // from a Mac running one — must still let you dig yourself out.
  const stuck = capacityApi(sizedWorkbook(12000, 45));
  const level = stuck.api.capacity();
  assert.ok(level.cells.used > level.cells.limit, 'this one is past the limit already');
  assert.equal(stuck.api.refusal({}), null,
    'refusing every change here would be a trap with no exit');
  assert.equal(stuck.api.refusal({ cells: -100 }), null, 'deleting is allowed');
  assert.ok(stuck.api.refusal({ cells: 1, bytes: 100 }),
    'but making it worse is still refused');
});

test('MB161-011: capacity is measured, never written', () => {
  const workbook = sizedWorkbook(200, 10);
  const before = JSON.stringify(workbook);
  const { api } = capacityApi(workbook);
  api.capacity();
  api.refusal({ cells: 5000 });
  api.refuse({ cells: 5000 });
  api.notice();
  assert.equal(JSON.stringify(workbook), before, 'reading the level does not change it');
});

test('MB161-011: a missing or malformed workbook does not throw', () => {
  for (const junk of [null, {}, { projects: null }, { projects: [{ sheets: null }] }]) {
    const { api } = capacityApi(junk);
    assert.doesNotThrow(() => api.capacity());
    assert.doesNotThrow(() => api.notice());
    assert.equal(api.capacity().cells.used, 0);
  }
});

test('MB161-011: the edit paths ask before they mutate, not after', () => {
  // The whole point is the ORDER. Checking after the mutation would leave the
  // workbook unsaveable, which is the bug this replaces.
  const addRow = declaration('ssAddRow');
  assert.ok(addRow.indexOf('ssRefuseIfFull') < addRow.indexOf('ssPushUndo'),
    'ssAddRow refuses before it touches anything');
  const addCol = declaration('ssAddCol');
  assert.ok(addCol.indexOf('ssRefuseIfFull') < addCol.indexOf('ssPushUndo'),
    'ssAddCol too');

  const commit = declaration('ssCommitEdit');
  assert.ok(commit.indexOf('_ssCapacityRefusal') < commit.indexOf('sheet.cells[k] = {'),
    'ssCommitEdit checks before it writes the cell');
  assert.match(commit, /value\.length > previous\.length/,
    'and only when the cell grows, so ordinary typing pays nothing');
  assert.match(commit, /inp\.textContent = previous/,
    'a refused edit puts the old text back rather than leaving a phantom');

  const importer = declaration('ssImportBuildProject');
  assert.ok(importer.indexOf('_ssCapacityRefusal') < importer.indexOf('STORE.replace'),
    'an import is measured before a single byte is stored');
  assert.match(importer, /filled cells\. \$\{refusal\}/,
    'and the refusal names the size of the file that was rejected');
});

// ── MB161-018: importing a Google grid, not just its text ───────────────────
//
// A studio schedule keeps most of its meaning in the fills (a black cell is a
// blocked-out slot) and the merges (one lesson spanning two 15-minute rows).
// The first import dropped both and produced a grid that was technically the
// same data and practically unusable. These exercise the real functions.

function importApi() {
  const context = vm.createContext({ Object, Array, Number, String, JSON, Boolean });
  vm.runInContext(`
    ${declaration('_ssImportColor')}
    ${declaration('_ssApplyImportedMerges')}
    globalThis.api = {
      color: value => _ssImportColor(value),
      merge: (cells, merges, rows, cols) => {
        _ssApplyImportedMerges(cells, merges, rows, cols);
        return cells;
      },
    };
  `, context);
  return context.api;
}

test('MB161-018: only a real hex is accepted as an imported colour', () => {
  const api = importApi();
  assert.equal(api.color('#1A2B3C'), '#1a2b3c', 'normalized to lower case');
  assert.equal(api.color('#000000'), '#000000', 'black is a colour, not an absence');
  // Everything else becomes "no colour" rather than being stored and handed to
  // CSS, which is how `red; background:url(...)` would have got a look-in.
  for (const junk of ['red', 'rgb(1,2,3)', '#abc', '#12345g', '', null, undefined, 42, {},
                      '#123456; background:url(x)']) {
    assert.equal(api.color(junk), '', `${JSON.stringify(junk)} is not a colour`);
  }
});

test('MB161-018: a merge claims its region and leaves no cell underneath', () => {
  const api = importApi();
  const cells = {
    '0,0': { v: 'Zachary P', bg: '#cccccc', tc: '', b: false },
    '1,0': { v: '', bg: '#cccccc', tc: '', b: false },   // covered by the merge
    '2,0': { v: 'keep me', bg: '', tc: '', b: false },   // outside it
  };
  const out = api.merge(cells, [{ row: 0, column: 0, rowSpan: 2, colSpan: 1 }], 10, 5);
  assert.deepEqual(Object.keys(out).sort(), ['0,0', '2,0']);
  assert.equal(out['0,0'].rs, 2);
  assert.equal(out['0,0'].cs, 1);
  assert.equal(out['0,0'].v, 'Zachary P', 'the anchor keeps its value');
  // The workbook validator refuses a cell inside a merged region outright, so
  // "the covered cell is gone" is not tidiness — leaving it quarantines the
  // project on the next save.
  assert.equal(out['1,0'], undefined);
});

test('MB161-018: a merged block inherits a fill its anchor lacks', () => {
  // Google puts the value in the top-left of a merge but paints every covered
  // cell. If the anchor happens to carry no fill of its own, taking the region's
  // is what stops a coloured block importing as a white one.
  const api = importApi();
  const out = api.merge({
    '0,0': { v: 'Music Mix', bg: '', tc: '', b: false },
    '0,1': { v: '', bg: '#6d8fe0', tc: '', b: false },
  }, [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }], 10, 5);
  assert.equal(out['0,0'].bg, '#6d8fe0');
});

test('MB161-018: overlapping merges cannot both be applied', () => {
  // Two merges claiming the same cell is a workbook the validator rejects. A
  // spreadsheet cannot really produce this, but a corrupt or hostile response
  // can, and the failure mode is a project that will not save.
  const api = importApi();
  const out = api.merge({ '0,0': { v: 'a', bg: '', tc: '', b: false } }, [
    { row: 0, column: 0, rowSpan: 2, colSpan: 2 },
    { row: 1, column: 1, rowSpan: 2, colSpan: 2 },   // overlaps the first
  ], 10, 5);
  assert.equal(out['0,0'].rs, 2);
  assert.equal(out['1,1'], undefined, 'the second merge was dropped, not written');
  const spans = Object.values(out).filter(cell => cell.rs > 1 || cell.cs > 1);
  assert.equal(spans.length, 1);
});

test('MB161-018: a merge running past the grid is clipped, not dropped', () => {
  const api = importApi();
  const out = api.merge({ '0,0': { v: 'x', bg: '', tc: '', b: false } },
    [{ row: 0, column: 0, rowSpan: 99, colSpan: 99 }], 4, 3);
  assert.equal(out['0,0'].rs, 4, 'clipped to the stored row count');
  assert.equal(out['0,0'].cs, 3, 'and the stored column count');
});

test('MB161-018: junk merges are ignored rather than throwing', () => {
  const api = importApi();
  const out = api.merge({ '0,0': { v: 'x', bg: '', tc: '', b: false } }, [
    null, 'nope', {}, { row: -1, column: 0, rowSpan: 2, colSpan: 2 },
    { row: 0, column: 0, rowSpan: 1, colSpan: 1 },        // a 1x1 is not a merge
    { row: 99, column: 99, rowSpan: 2, colSpan: 2 },      // anchor off the grid
    { row: 0, column: 0, rowSpan: NaN, colSpan: 2 },
  ], 10, 5);
  assert.deepEqual(Object.keys(out), ['0,0']);
  assert.equal(out['0,0'].rs, undefined, 'none of those was applied');
});

test('MB161-018: a link written before multi-tab still pulls and pushes', () => {
  // The tab name and checkpoint moved out of the link and into a map keyed by
  // sheet. Somebody who imported a tab on the previous build has the old shape
  // stored and synced. Reading it as a one-entry map is what stops their
  // project silently losing its link on first launch.
  const api = roundTripApi();
  const out = api.norm({
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'P', activeId: 's1',
      sheets: [{ id: 's1', name: 'Monday', rows: 3, cols: 3, colWidths: [], cells: {} }],
      googleLink: {
        spreadsheetId: '1zZ4M7ewY7cFBePc2nV-kX2j-YHr0rilPQ6bFvB7WYrg',
        title: 'Monday', rows: 500, columns: 100,
        checkpoint: { '0,0': 'TIME' },
      },
    }],
  });
  const link = out.projects[0].googleLink;
  assert.equal(link.title, undefined, 'the old top-level field is gone');
  assert.deepEqual(link.tabs, { s1: { title: 'Monday', checkpoint: { '0,0': 'TIME' } } });
  assert.equal(link.spreadsheetId, '1zZ4M7ewY7cFBePc2nV-kX2j-YHr0rilPQ6bFvB7WYrg');
});

test('MB161-018: a tab map survives normalization intact', () => {
  const api = roundTripApi();
  const out = api.norm({
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'Color Block', activeId: 's1',
      sheets: [
        { id: 's1', name: 'Monday',  rows: 3, cols: 3, colWidths: [], cells: {} },
        { id: 's2', name: 'Tuesday', rows: 3, cols: 3, colWidths: [], cells: {} },
      ],
      googleLink: {
        spreadsheetId: '1zZ4M7ewY7cFBePc2nV-kX2j-YHr0rilPQ6bFvB7WYrg',
        rows: 500, columns: 100,
        tabs: {
          s1: { title: 'Monday',  checkpoint: { '0,0': 'TIME' } },
          s2: { title: 'Tuesday', checkpoint: { '0,0': 'TIME' } },
          // A tab pointing at a sheet this project does not have can never be
          // pulled or pushed; keeping it would only grow the document.
          s9: { title: 'Ghost', checkpoint: { '0,0': 'x' } },
        },
      },
    }],
  });
  assert.deepEqual(Object.keys(out.projects[0].googleLink.tabs).sort(), ['s1', 's2']);
});

test('MB161-018: a link naming no reachable tab is dropped entirely', () => {
  // Otherwise the project keeps a Google badge and Pull/Push buttons that
  // cannot do anything, which reads as "connected" when it is not.
  const api = roundTripApi();
  const out = api.norm({
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'P', activeId: 's1',
      sheets: [{ id: 's1', name: 'S', rows: 3, cols: 3, colWidths: [], cells: {} }],
      googleLink: {
        spreadsheetId: '1zZ4M7ewY7cFBePc2nV-kX2j-YHr0rilPQ6bFvB7WYrg',
        rows: 500, columns: 100, tabs: { sGone: { title: 'Monday' } },
      },
    }],
  });
  assert.equal(out.projects[0].googleLink, undefined);
});

// ── MB161-020: checkboxes ───────────────────────────────────────────────────

test('MB161-020: a checkbox is TRUE/FALSE text, so a push needs no special case', () => {
  const context = vm.createContext({ String });
  vm.runInContext(`
    ${declaration('_ssIsChecked')}
    globalThis.checked = value => _ssIsChecked(value);
  `, context);
  // Google writes the literal strings, and case/whitespace vary by locale and
  // by how the value got there.
  assert.equal(context.checked('TRUE'), true);
  assert.equal(context.checked('true'), true);
  assert.equal(context.checked(' TRUE '), true);
  assert.equal(context.checked('FALSE'), false);
  assert.equal(context.checked(''), false);
  assert.equal(context.checked(undefined), false);
  // Not a truthiness test: any other text is an unticked box, not a ticked one.
  assert.equal(context.checked('yes'), false);
  assert.equal(context.checked('1'), false);
});

test('MB161-020: the checkbox flag survives normalization, and only when set', () => {
  const api = roundTripApi();
  const out = api.norm(book({
    '0,0': { v: 'TRUE', bg: '', tc: '', b: false, cb: true },
    '0,1': { v: 'plain', bg: '', tc: '', b: false },
  }));
  const cells = out.projects[0].sheets[0].cells;
  assert.equal(cells['0,0'].cb, true);
  assert.equal(cells['0,0'].v, 'TRUE', 'the value is still the text Google stores');
  // Absent rather than false on ordinary cells: a field per cell across a full
  // workbook is real weight against the 600 KB budget.
  assert.ok(!('cb' in cells['0,1']));
});

test('MB161-020: a non-boolean checkbox flag is refused, not coerced', () => {
  // The flag decides whether a cell is interactive, so a junk value must not
  // quietly become `true` via truthiness.
  const api = roundTripApi();
  for (const junk of ['true', 1, {}, []]) {
    assert.throws(
      () => api.norm(book({ '0,0': { v: 'x', bg: '', tc: '', b: false, cb: junk } })),
      /invalid checkbox flag/,
      `${JSON.stringify(junk)} is refused`);
  }
});

// ── MB161-021: Google's changes arrive without discarding work done here ────

function mergeApi() {
  const context = vm.createContext({ String });
  vm.runInContext(`
    ${declaration('_ssMergeCellFromGoogle')}
    globalThis.api = (base, remote, local) => _ssMergeCellFromGoogle(base, remote, local);
  `, context);
  const cell = v => (v === null ? null : { v, bg: '', tc: '', b: false });
  return (base, remote, local) => context.api(base, cell(remote), cell(local));
}

test('MB161-021: a cell Google has not touched keeps whatever the app has', () => {
  // The whole reason for the merge. The studio edits in the app now, so a sync
  // that took Google's copy wholesale would throw away the primary version
  // every few minutes.
  const merge = mergeApi();
  assert.equal(merge('Zachary P', 'Zachary P', 'Zachary Pine').take, 'local');
  assert.equal(merge('Zachary P', 'Zachary P', 'Zachary Pine').cell.v, 'Zachary Pine');
  // Including a cell the app cleared.
  assert.equal(merge('Zachary P', 'Zachary P', null).take, 'local');
  assert.equal(merge('Zachary P', 'Zachary P', null).cell, null);
});

test('MB161-021: a cell only Google changed comes across', () => {
  const merge = mergeApi();
  assert.equal(merge('Zachary P', 'Zachary Pine', 'Zachary P').take, 'remote');
  assert.equal(merge('Zachary P', 'Zachary Pine', 'Zachary P').cell.v, 'Zachary Pine');
  // New in Google: no base, nothing locally.
  assert.equal(merge(undefined, 'Mia Gemma', null).take, 'remote');
  // Deleted in Google, untouched here: the deletion is real and comes across.
  const deleted = merge('Zachary P', null, 'Zachary P');
  assert.equal(deleted.take, 'remote');
  assert.equal(deleted.cell, null);
});

test('MB161-021: when both changed, the app wins and it is flagged', () => {
  // Never silently overwritten. This is the answer to "what if two people
  // edited the same cell", and it matches what the two-Mac sync already does.
  const merge = mergeApi();
  const clash = merge('Zachary P', 'Zachary Pine', 'Zach Pine');
  assert.equal(clash.take, 'conflict');
  assert.equal(clash.cell.v, 'Zach Pine', "the app's value is what stays on screen");

  // Agreeing by coincidence is not a conflict.
  assert.equal(merge('Zachary P', 'Zach P', 'Zach P').take, 'local');
  // Deleted in Google, edited here: still a clash, and the app's text survives.
  const both = merge('Zachary P', null, 'Zach Pine');
  assert.equal(both.take, 'conflict');
  assert.equal(both.cell.v, 'Zach Pine');
});

test('MB161-021: an absent base is treated as empty, not as "changed"', () => {
  // A cell that has never been seen by a sync has no checkpoint entry. Reading
  // that as "the base was undefined, so everything differs from it" would make
  // every untouched empty cell a conflict on the first run.
  const merge = mergeApi();
  assert.equal(merge(undefined, null, null).take, 'local');
  assert.equal(merge(undefined, null, 'typed here').take, 'local',
    'a cell only the app has is left alone');
  assert.equal(merge('', null, 'typed here').take, 'local');
});

// ── MB161-023: a background sync must not silently disable the buttons ──────

test('MB161-023: a user action waits its turn instead of vanishing', async () => {
  // Reported as "Look up tabs worked a few seconds ago and now it doesn't."
  // The flag that serialises Google requests was checked with a bare
  // `if (busy) return`. That was fine while only buttons set it — a person
  // cannot press two at once — but an automatic background check can hold it
  // for as long as the network takes, and during that window the button did
  // nothing AND said nothing.
  const context = vm.createContext({ Date, Promise, setTimeout });
  vm.runInContext(`
    var _ssGoogleBusy = false;
    ${declaration('_ssGoogleAcquire')}
    globalThis.api = {
      acquire: ms => _ssGoogleAcquire(ms),
      hold: () => { _ssGoogleBusy = true; },
      release: () => { _ssGoogleBusy = false; },
      busy: () => _ssGoogleBusy,
    };
  `, context);

  assert.equal(await context.api.acquire(1000), true, 'a free gate is taken at once');
  assert.equal(context.api.busy(), true, 'and is held');

  // Held by something else and never released: the caller gives up, bounded,
  // rather than hanging on a promise that will not settle.
  const started = Date.now();
  assert.equal(await context.api.acquire(300), false);
  assert.ok(Date.now() - started >= 250, 'it really waited rather than failing instantly');

  // Released while waiting: the action proceeds, which is the whole point.
  context.api.release();
  context.api.hold();
  setTimeout(() => context.api.release(), 120);
  assert.equal(await context.api.acquire(3000), true, 'the wait resolves once the gate frees');
});

test('MB161-023: background work yields, and never queues behind a person', async () => {
  // A background tick that waited would pile up behind an import and then fire
  // a burst of reads the moment it finished. It has nothing to prove — it runs
  // again in a few minutes.
  const context = vm.createContext({ Date, Promise, setTimeout });
  vm.runInContext(`
    var _ssGoogleBusy = true;
    ${declaration('_ssGoogleAcquire')}
    globalThis.acquire = ms => _ssGoogleAcquire(ms);
  `, context);
  const started = Date.now();
  assert.equal(await context.acquire(0), false, 'a zero wait gives up immediately');
  assert.ok(Date.now() - started < 100, 'and does not sleep first');
});

test('MB161-028: removing a checkbox does not leave "FALSE" behind', () => {
  const context = vm.createContext({ Object, String });
  vm.runInContext(`
    ${declaration('_ssIsChecked')}
    // The removal branch of ssToggleCheckboxCells, isolated.
    globalThis.remove = cell => {
      const { cb, ...rest } = cell;
      return _ssIsChecked(cell.v) ? rest : { ...rest, v: '' };
    };
  `, context);

  // Unticked: the word FALSE is litter somebody then deletes by hand.
  const off = context.remove({ v: 'FALSE', bg: '', tc: '', b: false, cb: true });
  assert.equal(off.v, '');
  assert.equal(off.cb, undefined);
  // Ticked: that genuinely means something, so it survives losing its box.
  const on = context.remove({ v: 'TRUE', bg: '', tc: '', b: false, cb: true });
  assert.equal(on.v, 'TRUE');
  assert.equal(on.cb, undefined);
  // Formatting is never collateral damage either way.
  const styled = context.remove({ v: 'FALSE', bg: '#cccccc', tc: '', b: true, cb: true });
  assert.equal(styled.bg, '#cccccc');
  assert.equal(styled.b, true);
});

test('MB161-030: importing and syncing are not credited as edits', () => {
  // An import stamped one attribution per filled cell, so the activity panel
  // reported "179 changes" and outlined the whole schedule in the importer's
  // colour — burying the few real edits the panel exists to surface.
  const context = vm.createContext({ String });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    var _ssMirroringFromGoogle = false;
    var currentUser = () => 'Elizabeth Chaves';
    ${declaration('_ssAttributionActor')}
    globalThis.api = {
      actor: () => _ssAttributionActor(),
      mirroring: on => { _ssMirroringFromGoogle = on; },
    };
  `, context);

  assert.equal(context.api.actor(), 'Elizabeth Chaves', 'a real edit still names its author');
  context.api.mirroring(true);
  assert.equal(context.api.actor(), null, 'cells arriving from Google credit nobody');
  context.api.mirroring(false);
  assert.equal(context.api.actor(), 'Elizabeth Chaves', 'and it is only suppressed while mirroring');
});

// ── MB161-034: one shared AI budget, and the cheap model by default ─────────

function spendApi() {
  const context = vm.createContext({ Object, Number, Math, String, Array, Date, JSON });
  vm.runInContext(`
    var _store = {};
    var STORE = { get: (k, d) => (k in _store ? _store[k] : d) };
    var _device = 'mac-a';
    var _deviceId = () => _device;
    var AI_TEAM_MONTHLY_CAP_USD = 20;
    var AI_SPEND_KEY = 'ai_spend';
    var AI_MODEL_COSTS = {
      'claude-sonnet-4-6':         { input: 3, output: 15 },
      'claude-haiku-4-5-20251001': { input: 1, output: 5 },
    };
    var persistInBackground = (k, v) => { _store[k] = JSON.parse(JSON.stringify(v)); };
    ${declaration('_aiSpendMonth')}
    ${declaration('_aiSpendRecord')}
    ${declaration('getAiSpendThisMonth')}
    ${declaration('addAiSpend')}
    ${declaration('aiAtSpendLimit')}
    globalThis.api = {
      spend: (m, i, o) => addAiSpend(m, i, o),
      total: () => getAiSpendThisMonth(),
      capped: () => aiAtSpendLimit(),
      asDevice: id => { _device = id; },
      raw: () => _store.ai_spend,
      seed: v => { _store.ai_spend = v; },
    };
  `, context);
  return context.api;
}

test('MB161-034: the cap is the whole studio, not one Mac each', () => {
  // Two Macs at $15 apiece could spend $30 and neither would notice, because
  // the number anybody actually cares about was the one nothing tracked.
  const api = spendApi();
  api.asDevice('mac-a');
  api.spend('claude-sonnet-4-6', 1_000_000, 0);   // $3
  api.asDevice('mac-b');
  api.spend('claude-sonnet-4-6', 1_000_000, 0);   // $3
  assert.equal(Math.round(api.total() * 100) / 100, 6, 'both Macs count towards one total');
  assert.equal(api.capped(), false);

  api.spend('claude-sonnet-4-6', 5_000_000, 0);   // +$15 => $21
  assert.equal(api.capped(), true, 'and the cap is reached collectively');
});

test('MB161-034: one Mac writing cannot erase the other Mac’s figure', () => {
  // The reason for per-device subtotals rather than a single shared number:
  // two Macs writing a total would each overwrite the other.
  const api = spendApi();
  api.asDevice('mac-a');
  api.spend('claude-haiku-4-5-20251001', 1_000_000, 0);  // $1
  api.asDevice('mac-b');
  api.spend('claude-haiku-4-5-20251001', 2_000_000, 0);  // $2
  const record = api.raw();
  assert.deepEqual(Object.keys(record.devices).sort(), ['mac-a', 'mac-b']);
  assert.equal(record.devices['mac-a'], 1);
  assert.equal(record.devices['mac-b'], 2);
});

test('MB161-034: last month’s spend does not count against this month', () => {
  const api = spendApi();
  api.seed({ month: '2019-01', devices: { 'mac-a': 19.5 } });
  assert.equal(api.total(), 0, 'a stale month reads as nothing spent');
  assert.equal(api.capped(), false);
  // And junk cannot make the studio look either broke or free.
  for (const junk of [null, 'nope', [], { month: '2019-01' }, { devices: { a: 'lots' } }]) {
    api.seed(junk);
    assert.equal(api.total(), 0);
  }
});

test('MB161-034: the cheap model is the default, not the fallback', () => {
  const context = vm.createContext({ String });
  vm.runInContext(`
    var AI_CHEAPEST_MODEL = 'haiku';
    var AI_CAPABLE_MODEL = 'sonnet';
    ${declaration('selectAiModel')}
    globalThis.pick = q => selectAiModel(q);
  `, context);
  // Lookups, however they are phrased.
  for (const q of [
    'what time do you open', 'who teaches drums', 'how much is a lesson',
    'is guitar available on tuesday', 'do we have a room free at 4',
    'has Ana logged anything today',
  ]) assert.equal(context.pick(q), 'haiku', `"${q}" is a lookup`);

  // Only genuinely open-ended work earns the expensive model.
  for (const q of [
    'compare our lesson pricing to what similar studios charge and recommend a change',
    'why did attendance drop in July and what should we do about it',
    'draft an email to parents explaining the new schedule',
  ]) assert.equal(context.pick(q), 'sonnet', `"${q}" needs reasoning`);
});
