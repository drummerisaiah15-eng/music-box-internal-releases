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
    // MB1188-031: capacity now measures the sheet ceiling too.
    var MAX_SPREADSHEET_SHEETS = 25;
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
  const context = vm.createContext({ String, JSON, Object, Array });
  vm.runInContext(`
    ${declaration('_ssCheckpointCell')}
    ${declaration('_ssCellSignature')}
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
    var MAX_AI_SPEND_DEVICES = 24;
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

test('MB161-036: the shared spend record is bounded, and keeps this Mac', () => {
  // Each Mac holds its own subtotal, so the map is as long as the number of
  // machines that have spent this month — and a device id changes on reinstall,
  // so it grows without limit inside a synced document. Four Macs is nowhere
  // near the bound; the bound exists so nothing has to be true about how many.
  const api = spendApi();
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`mac-${i}`] = i + 1;   // 1..40
  api.seed({ month: new Date().toISOString().slice(0, 7), devices: many });

  api.asDevice('mac-new');
  api.spend('claude-haiku-4-5-20251001', 1_000_000, 0);       // $1
  const record = api.raw();
  const ids = Object.keys(record.devices);
  assert.ok(ids.length <= 24, `bounded, got ${ids.length}`);
  assert.ok(ids.includes('mac-new'),
    "this Mac is never the entry evicted, or it spends against a total that keeps forgetting it");
  // The big spenders survive: dropping them would understate the month and
  // quietly raise the cap.
  assert.ok(ids.includes('mac-39'), 'the largest subtotals are kept');
  assert.ok(!ids.includes('mac-0'), 'the smallest are the ones dropped');
});

test('MB161-036: four Macs each keep their own subtotal against one cap', () => {
  const api = spendApi();
  for (const mac of ['mac-a', 'mac-b', 'mac-c', 'mac-d']) {
    api.asDevice(mac);
    api.spend('claude-haiku-4-5-20251001', 4_000_000, 0);     // $4 each
  }
  assert.equal(Object.keys(api.raw().devices).length, 4);
  assert.equal(Math.round(api.total() * 100) / 100, 16);
  assert.equal(api.capped(), false, 'still under the shared $20');
  api.asDevice('mac-a');
  api.spend('claude-haiku-4-5-20251001', 5_000_000, 0);       // +$5 => $21
  assert.equal(api.capped(), true, 'and one more tips the studio over it');
});

// ── MB161-039: workload analytics ──────────────────────────────────────────

function workloadApi(now = Date.parse('2026-08-07T12:00:00Z')) {
  const context = vm.createContext({ Object, Array, Number, String, Math, JSON, Map, Set, Date });
  vm.runInContext(`
    var _now = ${now};
    var Date_ = Date;
    var _store = {};
    var STORE = { get: (k, d) => (k in _store ? _store[k] : d) };
    var _ssData = { projects: [] };
    var _loginProfiles = [];
    var _timestampMs = v => (typeof v === 'string' ? (Date.parse(v) || 0) : 0);
    ${declaration('_wlEmpty')}
    ${declaration('_ssWorkloadStats')}
    globalThis.api = {
      seedRoles: (logs, profiles) => {
        _store.logs = logs; _store.todo_items = []; _store.assigned_tasks = [];
        _ssData = { projects: [] };
        _loginProfiles = profiles;
      },
      seed: (logs, todos, tasks, sheets, roster) => {
        _store.logs = logs; _store.todo_items = todos; _store.assigned_tasks = tasks;
        _ssData = { projects: [{ sheets }] };
        _loginProfiles = (roster || ['Emma', 'Carrie', 'Ana']).map(name => ({ name }));
      },
      stats: since => {
        const s = _ssWorkloadStats(since);
        return { people: [...s.people.entries()], weeks: s.weeks,
                 unattributed: s.unattributed, departed: s.departed };
      },
    };
  `, context);
  return context.api;
}

test('MB161-039: spreadsheet edits count towards a profile, imports do not', () => {
  const now = Date.now();
  const since = now - 30 * 24 * 60 * 60 * 1000;
  const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const api = workloadApi();
  api.seed(
    [{ author: 'Emma', date: new Date(now).toISOString().slice(0, 10), created: recent }],
    [{ done: true, doneBy: 'Emma', doneAt: recent }],
    [],
    [{ editedBy: {
      '0,0': { by: 'Emma', at: recent },
      '0,1': { by: 'Carrie', at: recent },
      // Older than the window.
      '0,2': { by: 'Emma', at: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString() },
      // An import leaves no `by` at all (MB161-030), so it cannot be counted.
      '0,3': { at: recent },
    } }],
  );
  const stats = api.stats(since);
  const people = new Map(stats.people);
  assert.equal(people.get('Emma').cells, 1, 'only the edit inside the window');
  assert.equal(people.get('Carrie').cells, 1);
  assert.equal(people.get('Emma').logs, 1);
  assert.equal(people.get('Emma').todos, 1);
  // An unattributed stamp creates no phantom profile, and a name with no
  // current profile is not listed as staff.
  assert.ok(!people.has('undefined') && !people.has(''));
  // Every current profile appears, including one with nothing recorded.
  assert.ok(people.has('Ana'));
  assert.equal(people.get('Ana').logs + people.get('Ana').todos + people.get('Ana').cells, 0);
});

test('MB161-039: the three counts are never merged into one number', () => {
  // A person who edits 300 cells has not done thirty times the work of somebody
  // who wrote ten log entries. Keeping them separate is the whole point; a
  // single total would invite exactly that reading.
  const api = workloadApi();
  const now = Date.now();
  const at = new Date(now - 1000).toISOString();
  api.seed([], [], [], [{ editedBy: Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`0,${i}`, { by: 'Ana', at }])) }], ['Ana']);
  const counts = new Map(api.stats(now - 30 * 24 * 60 * 60 * 1000).people).get('Ana');
  assert.equal(counts.cells, 300);
  assert.equal(counts.logs, 0);
  assert.equal(counts.todos, 0);
  // No combined figure exists to be mistaken for a productivity number.
  assert.deepEqual(Object.keys(counts).sort(), ['cells', 'logs', 'todos']);

  // And the prompt says so, since the model would otherwise happily add them.
  const run = declaration('ssRunStaffWorkload');
  assert.match(run, /Never add them together or treat a larger number as more work done/);
});

test('MB161-039: the charts do not depend on the AI answering', () => {
  // The counts are arithmetic on data already present. Drawing them only after
  // a successful AI call would mean a spent budget or a network failure left
  // the page blank, when the numbers were available the whole time.
  // MB161-046: the drawing moved into ssRenderWorkloadCharts so a timer can
  // call it too; the ordering rule is unchanged.
  const run = declaration('ssRunStaffWorkload');
  const charts = run.indexOf('ssRenderWorkloadCharts()');
  const send = run.indexOf('_sendAiMessage(');
  assert.ok(charts > -1 && send > -1 && charts < send,
    'the charts are rendered before the request is made');
});

test('MB161-041: the roster is who has a profile now, at zero or otherwise', () => {
  // A deleted profile ("Test") kept appearing because counting was driven by
  // whatever name was in the records, while anybody who logged nothing was
  // absent — the opposite of useful, since a person with no recorded activity
  // is exactly who a workload review should surface.
  const now = Date.now();
  const at = new Date(now - 1000).toISOString();
  const api = workloadApi();
  api.seed(
    [{ author: 'Test', date: new Date(now).toISOString().slice(0, 10), created: at },
     { author: 'Emma', date: new Date(now).toISOString().slice(0, 10), created: at }],
    [], [], [], ['Emma', 'Kylie', 'Ana'],
  );
  const stats = api.stats(now - 30 * 24 * 60 * 60 * 1000);
  const people = new Map(stats.people);
  assert.deepEqual([...people.keys()].sort(), ['Ana', 'Emma', 'Kylie']);
  assert.equal(people.get('Emma').logs, 1);
  assert.equal(people.get('Kylie').logs, 0, 'listed, with nothing recorded');
  assert.ok(!people.has('Test'), 'a name with no current profile is not staff');
  assert.equal(stats.departed, 1, 'but its records are counted and reported');
});

test('MB161-042: an import’s stamps are not shown as somebody’s edits', () => {
  // Imports stopped being attributed in MB161-030, but stamps written by
  // earlier builds are still in the data — which is why one import still read
  // as "179 changes" by whoever pressed the button.
  const context = vm.createContext({ Object, Array, Number, String, Date, Math });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_normalizeSpreadsheetAttribution')}
    globalThis.norm = (source, cells) => _normalizeSpreadsheetAttribution(source, cells);
  `, context);

  const cells = {};
  const bulk = {};
  // 179 cells stamped in the same second: an import.
  for (let i = 0; i < 179; i += 1) {
    cells[`0,${i}`] = { v: 'x' };
    bulk[`0,${i}`] = { by: 'Elizabeth Chaves', at: '2026-08-07T14:26:03.100Z' };
  }
  // Three cells somebody actually typed, at different moments.
  for (let i = 0; i < 3; i += 1) {
    cells[`1,${i}`] = { v: 'y' };
    bulk[`1,${i}`] = { by: 'Carrie Gass', at: `2026-08-07T15:0${i}:11.000Z` };
  }
  const kept = context.norm(bulk, cells);
  const names = Object.values(kept).map(entry => entry.by);
  assert.equal(names.filter(n => n === 'Carrie Gass').length, 3, 'real edits survive');
  assert.equal(names.filter(n => n === 'Elizabeth Chaves').length, 0,
    'the import burst is dropped');
});

test('MB161-042: ordinary fast typing is never mistaken for an import', () => {
  // The rule is forty stamps sharing an author AND a second. Somebody working
  // quickly does not produce that, and treating them as an import would erase
  // the very edits the panel exists to show.
  const context = vm.createContext({ Object, Array, Number, String, Date, Math });
  vm.runInContext(`
    var MAX_SPREADSHEET_ATTRIBUTIONS = 200;
    var MAX_SPREADSHEET_ATTRIBUTION_NAME = 80;
    ${declaration('_normalizeSpreadsheetAttribution')}
    globalThis.norm = (source, cells) => _normalizeSpreadsheetAttribution(source, cells);
  `, context);
  const cells = {};
  const stamps = {};
  for (let i = 0; i < 39; i += 1) {
    cells[`0,${i}`] = { v: 'x' };
    stamps[`0,${i}`] = { by: 'Ana Chaves', at: '2026-08-07T14:26:03.100Z' };
  }
  assert.equal(Object.keys(context.norm(stamps, cells)).length, 39,
    'thirty-nine in one second is still credited');
});

test('MB161-043: an overlapping merge is repaired, not made fatal', () => {
  // This threw, which meant one bad span made the ENTIRE workbook unsaveable:
  // the save was refused, the editor was thrown back to the project list, and
  // the same failure recurred on load — locking people out of their own data.
  // A span is layout, not content: dropping it keeps the cell and its text.
  const api = roundTripApi();
  const out = api.norm({
    activeProject: 'p1',
    projects: [{
      id: 'p1', name: 'P', activeId: 's1',
      sheets: [{
        id: 's1', name: 'S', rows: 6, cols: 6, colWidths: [],
        cells: {
          // Two merges claiming 1,0.
          '0,0': { v: 'first',  bg: '', tc: '', b: false, rs: 3, cs: 1 },
          '1,0': { v: 'second', bg: '', tc: '', b: false, rs: 2, cs: 1 },
          '4,4': { v: 'elsewhere', bg: '', tc: '', b: false },
        },
      }],
    }],
  });
  const cells = out.projects[0].sheets[0].cells;
  // Nothing was lost, and the workbook loaded at all — which is the point.
  assert.equal(cells['4,4'].v, 'elsewhere');
  assert.ok(cells['0,0'] || cells['1,0'], 'the merged cells survive');
  // And no two spans still claim the same cell.
  const claimed = new Set();
  for (const [key, cell] of Object.entries(cells)) {
    const [row, col] = key.split(',').map(Number);
    for (let r = row; r < row + (cell.rs || 1); r += 1) {
      for (let c = col; c < col + (cell.cs || 1); c += 1) {
        const at = `${r},${c}`;
        assert.ok(!claimed.has(at), `${at} is claimed twice`);
        claimed.add(at);
      }
    }
  }
});

test('MB161-044: the workload leaves out whoever is reading it', () => {
  // The Owner and the Operations Manager are the reviewers. Listing them beside
  // the reviewed invites a comparison that means nothing — most of their work
  // never becomes a log entry or a ticked-off to-do in the first place.
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const at = new Date(now - 1000).toISOString();
  const api = workloadApi();
  api.seedRoles(
    [{ author: 'Elizabeth', date: day, created: at },
     { author: 'Megan',     date: day, created: at },
     { author: 'Ana',       date: day, created: at }],
    [{ name: 'Elizabeth', role: 'Owner' },
     { name: 'Megan',     role: 'Operations Manager' },
     { name: 'Ana',       role: 'Front Desk' },
     { name: 'Kylie',     role: 'Front Desk' }],
  );
  const stats = api.stats(now - 30 * 24 * 60 * 60 * 1000);
  const people = new Map(stats.people);
  assert.deepEqual([...people.keys()].sort(), ['Ana', 'Kylie']);
  // And a reviewer is not reported as a departed profile — she is sitting right
  // there; her records are simply out of scope.
  assert.equal(stats.departed, 0);
});

// ── MB1188-011: formatting is part of the cell, not decoration ──────────────

function richMergeApi() {
  const context = vm.createContext({ String, JSON, Object, Array });
  vm.runInContext(`
    ${declaration('_ssCheckpointEntry')}
    ${declaration('_ssCheckpointCell')}
    ${declaration('_ssCellSignature')}
    ${declaration('_ssMergeCellFromGoogle')}
    globalThis.api = {
      merge: (base, remote, local) => _ssMergeCellFromGoogle(base, remote, local),
      entry: cell => _ssCheckpointEntry(cell),
      signature: cell => _ssCellSignature(cell),
    };
  `, context);
  return context.api;
}

const gcell = over => ({ v: 'Booked', bg: '', tc: '', b: false, ...over });

test('MB1188-011: a fill applied in Google arrives instead of vanishing', () => {
  const api = richMergeApi();
  // Text identical on all three sides; only Google's fill moved. Comparing
  // `.v` alone classified this "take local" and the colour was lost silently.
  const base = api.entry(gcell({}));
  const outcome = api.merge(base, gcell({ bg: '#ffd966' }), gcell({}));
  assert.equal(outcome.take, 'remote');
  assert.equal(outcome.cell.bg, '#ffd966');
});

test('MB1188-011: a checkbox ticked in Google arrives', () => {
  const api = richMergeApi();
  const base = api.entry(gcell({ v: '', cb: true }));
  const outcome = api.merge(base, { v: 'TRUE', bg: '', tc: '', b: false, cb: true },
    gcell({ v: '', cb: true }));
  assert.equal(outcome.take, 'remote', 'the tick is a change like any other');
});

test('MB1188-011: bold and text colour count too', () => {
  const api = richMergeApi();
  for (const change of [{ b: true }, { tc: '#c0392b' }]) {
    const base = api.entry(gcell({}));
    assert.equal(api.merge(base, gcell(change), gcell({})).take, 'remote',
      `${JSON.stringify(change)} is a change`);
  }
});

test('MB1188-011: formatting changed on both sides is a conflict, not a silent loss', () => {
  const api = richMergeApi();
  const base = api.entry(gcell({}));
  const outcome = api.merge(base, gcell({ bg: '#ffd966' }), gcell({ bg: '#6aa84f' }));
  assert.equal(outcome.take, 'conflict');
  assert.equal(outcome.cell.bg, '#6aa84f', 'and this Mac keeps its own until resolved');
});

test('MB1188-011: an unformatted cell still checkpoints as a bare string', () => {
  // Both for backward compatibility with every checkpoint already written and
  // because an object per cell across a full sheet is real sync weight.
  const api = richMergeApi();
  assert.equal(api.entry(gcell({})), 'Booked');
  assert.deepEqual(JSON.parse(JSON.stringify(api.entry(gcell({ bg: '#ffd966' })))),
    { v: 'Booked', bg: '#ffd966' });
  assert.equal(api.entry({ v: '', bg: '', tc: '', b: false }), null, 'a blank cell is not recorded');
});

test('MB1188-011: a legacy text-only checkpoint still reads correctly', () => {
  const api = richMergeApi();
  // Written by an older build: a plain string. Google has not changed it.
  assert.equal(api.merge('Booked', gcell({}), gcell({ v: 'Edited here' })).take, 'local',
    'an old checkpoint must not suddenly read as a change');
  assert.equal(api.merge('Booked', gcell({ v: 'Changed in Google' }), gcell({})).take, 'remote');
});

test('MB1188-011: absent, blank and unformatted-blank are the same cell', () => {
  const api = richMergeApi();
  assert.equal(api.signature(null), '');
  assert.equal(api.signature({ v: '', bg: '', tc: '', b: false }), '');
  assert.equal(api.signature({ v: '', bg: '', tc: '', b: false, cb: false }), '');
  assert.notEqual(api.signature({ v: '', bg: '', tc: '', b: false, cb: true }), '',
    'an empty checkbox cell is not nothing');
});

// ── The custom fill colour is picked in the app, not by the system ──────────

function colourPickerApi() {
  const context = vm.createContext({ Math, Number, String, parseInt });
  vm.runInContext(`
    ${declaration('_ssHsvToHex')}
    ${declaration('_ssHexToHsv')}
    globalThis.toHex = (h, s, v) => _ssHsvToHex(h, s, v);
    globalThis.toHsv = hex => _ssHexToHsv(hex);
  `, context);
  return context;
}

test('custom fill colour: hex survives a round trip exactly', () => {
  // The picker stores hue/saturation/value and writes hex into the cell. If the
  // conversion drifts, reopening the picker on a cell shifts its colour
  // slightly every time — a fill that changes shade each time you look at it.
  const api = colourPickerApi();
  for (const hex of ['#ff9902', '#000000', '#ffffff', '#b8892b', '#6aa84f',
                     '#ffd966', '#3c78d8', '#a0a0a0']) {
    const hsv = api.toHsv(hex);
    assert.ok(hsv, `${hex} parses`);
    assert.equal(api.toHex(hsv.h, hsv.s, hsv.v), hex, `${hex} round-trips exactly`);
  }
});

test('custom fill colour: malformed input is rejected, never guessed', () => {
  const api = colourPickerApi();
  for (const junk of ['nope', '', null, undefined, '#12345', '#gggggg', '12345678']) {
    assert.equal(api.toHsv(junk), null, `${String(junk)} is refused`);
  }
  // Both spellings people actually type are accepted.
  assert.ok(api.toHsv('ff9902'));
  assert.ok(api.toHsv('  #FF9902  '));
});

test('custom fill colour: the picker is in-page, positioned right of the grid', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // The system colour panel opened at the far left over the sidebar, and its
  // position is not the page's to set. An <input type="color"> would bring it
  // straight back.
  // Comments are stripped first. Prose explaining WHY the native input was
  // removed naturally quotes it, and scanning the raw file reports that
  // explanation as the very thing it is describing — which has now happened
  // three separate times in this codebase.
  const code = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(line => line.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /<input\b[^>]*\btype="color"/,
    'no native colour input — macOS positions that panel itself');
  assert.match(source, /id="ss-color-popover"/, 'the picker is in the page');
  const place = declaration('_ssPositionColorPicker');
  assert.match(place, /popover\.style\.right = right \+ 'px'/, 'anchored from the right edge');
  assert.match(place, /Math\.max\(12, Math\.min\(top, window\.innerHeight - height - 12\)\)/,
    'and clamped so a short window cannot open it off screen');
});

test('custom fill colour: the picker closes and stops listening', () => {
  // Every listener added on open is removed on close; a stray document-level
  // pointerdown or keydown handler would keep firing over the grid forever.
  // The listeners live on the shared opener now: the toolbar swatch and the
  // colour-key swatch both route through it.
  const open = declaration('ssOpenColorPickerFor');
  const close = declaration('ssCloseColorPicker');
  for (const [listener, handler] of [
    ['pointerdown', '_ssColorPickerOutside'],
    ['keydown', '_ssColorPickerEscape'],
  ]) {
    assert.ok(open.includes(`addEventListener('${listener}', ${handler}, true)`),
      `open adds ${listener}`);
    assert.ok(close.includes(`removeEventListener('${listener}', ${handler}, true)`),
      `close removes ${listener}`);
  }
  assert.match(open, /window\.addEventListener\('resize', _ssPositionColorPicker\)/);
  assert.match(close, /window\.removeEventListener\('resize', _ssPositionColorPicker\)/);
  assert.match(declaration('_ssColorPickerEscape'), /event\.stopPropagation\(\)/,
    'Escape closes the picker without also cancelling the cell edit underneath');
});

test('MB1188-020: the colour-key swatch uses the in-app picker too', () => {
  // It built a hidden <input type="color"> and clicked it, which is the same
  // system panel — and the same wrong corner of the screen — that the fill
  // swatch had already been moved away from.
  const pick = declaration('ssKeyPickColor');
  assert.match(pick, /ssOpenColorPickerFor\(\s*\{ kind: 'key', index: i, was:/);
  assert.doesNotMatch(pick, /createElement\('input'\)/, 'no hidden native input');
  const apply = declaration('ssColorPickerApply');
  assert.match(apply, /_ssPickerTarget\.kind === 'key'/, 'apply routes to whatever opened it');
  assert.match(apply, /ssApplyCustomColor\(value\)/, 'and still fills cells otherwise');
});

test('the colour picker can sample any pixel on screen', () => {
  // The magnifier from Apple's colour panel. Chromium ships the EyeDropper
  // API, so this uses the platform's own picker rather than reimplementing
  // one — it samples a real pixel, including from other windows.
  const pick = declaration('ssColorPickerEyedropper');
  assert.match(pick, /new window\.EyeDropper\(\)\.open\(\)/);
  assert.match(pick, /ssColorPickerHex\(result\.sRGBHex\)/, 'the sampled colour lands in the picker');
  assert.match(pick, /typeof window\.EyeDropper !== 'function'/,
    'and it says so rather than throwing where the API is missing');

  // Cancelling a pick is a change of mind, not a failure.
  assert.match(pick, /catch \(_\) \{/);
  assert.match(pick, /finally \{\s*\n\s*_ssEyedropperOpen = false;/,
    'the guard is always released, including on cancel');

  // The eyedropper's own overlay must not read as a click outside the popover,
  // which would close the picker halfway through the pick.
  assert.match(declaration('_ssColorPickerOutside'), /if \(_ssEyedropperOpen\) return;/);

  // A control that cannot work should not be offered.
  assert.match(declaration('ssOpenColorPickerFor'),
    /dropper\.style\.display = typeof window\.EyeDropper === 'function' \? '' : 'none'/);
});

test('AUDIT: the colour picker cannot recolour the wrong key entry', () => {
  // Colour key entries have no ids, so an index is all there is to go on — and
  // an arriving change from another Mac can add, remove or reorder entries
  // while the picker is open.
  const context = vm.createContext({ Object, Array, String });
  vm.runInContext(`
    ${declaration('_ssPickerKeyEntry')}
    globalThis.find = (entries, target) => _ssPickerKeyEntry({ entries }, target);
  `, context);
  const entry = (label, bg) => ({ bg, tc: '#333333', label });
  const piano = entry('Piano', '#ffd966');
  const drums = entry('Drums', '#6aa84f');
  const target = { kind: 'key', index: 1, was: { ...drums } };

  assert.equal(context.find([piano, drums], target)?.label, 'Drums', 'found where it was');
  // Another Mac inserted a row above it: the index now points at the wrong one.
  assert.equal(context.find([piano, entry('Groups', '#3c78d8'), drums], target)?.label,
    'Drums', 'followed the entry, not the index');
  // It was deleted: refuse rather than recolour whatever moved into that slot.
  assert.equal(context.find([piano], target), null, 'gone means gone');
  assert.match(declaration('ssColorPickerApply'),
    /That colour key entry has changed/, 'and the person is told, not ignored');
});

// ── MB1188-014: a narrow Google column must not destroy the import ───────────
//
// Reported as "That spreadsheet was not imported: spreadsheets has invalid
// column widths" on a real sheet. Three places defined the legal range for a
// width and they disagreed: main.js clamped Google's pixelSize to 24..600, the
// importer mirrored that, and normalizeSpreadsheetWorkbook demanded 40..1000.
// Any column narrower than 40px — a spacer, a checkbox column — landed in the
// 24..39 gap and the whole workbook was refused.
//
// These run the real normalizer and look at what it produced. A test that
// merely asserted the source mentions a clamp would have passed against the
// broken code, which is the mistake that shipped this bug's neighbours.

const widthBook = (colWidths, cells = { '0,0': cell('KEEP ME') }) => ({
  activeProject: 'p1',
  projects: [{
    id: 'p1', name: 'P', activeId: 's1',
    sheets: [{ id: 's1', name: 'S', rows: 3, cols: 3, colWidths, cells }],
  }],
});

test('MB1188-014: a 30px column is coerced, not refused, and the workbook survives', () => {
  const { norm } = roundTripApi();

  // 30 is squarely in the gap: main.js would emit it, the normalizer refused it.
  const normalized = norm(widthBook([30, 100, 100]));
  const sheet = normalized.projects[0].sheets[0];

  assert.deepEqual(sheet.colWidths, [40, 100, 100], 'the narrow column is widened to the floor');
  // The point of the fix: the rest of the workbook still arrives. Refusing was
  // costing every cell in the project, not merely the width.
  assert.equal(sheet.cells['0,0'].v, 'KEEP ME', 'and no content was lost to a width');
  assert.equal(normalized.projects[0].name, 'P');
});

test('MB1188-014: widths out of range in either direction are clamped, never thrown', () => {
  const { norm } = roundTripApi();
  const widths = v => norm(widthBook(v)).projects[0].sheets[0].colWidths;

  assert.deepEqual(widths([39]), [40], 'one below the floor');
  assert.deepEqual(widths([24]), [40], 'the old producer floor');
  assert.deepEqual(widths([1001]), [1000], 'above the ceiling');
  assert.deepEqual(widths([0]), [40], 'zero, which Google uses for hidden');
  assert.deepEqual(widths([-5]), [40], 'negative');
  assert.deepEqual(widths(['abc']), [100], 'not a number at all falls back');
  assert.deepEqual(widths([40, 1000]), [40, 1000], 'the bounds themselves are untouched');
});

test('MB1188-014: structure is still refused — coercion is only for decoration', () => {
  const { norm } = roundTripApi();
  // Four widths on a three-column sheet is a broken record, not an ugly one.
  assert.throws(() => norm(widthBook([100, 100, 100, 100])),
    /invalid column widths/, 'more widths than columns still refuses');
  assert.throws(() => norm(widthBook('100,100')),
    /invalid column widths/, 'a non-array still refuses');
});

test('MB1188-014: every width main.js can emit is accepted by the workbook validator', () => {
  // A cross-module contract, executed rather than pattern-matched. main.js and
  // the normalizer live in different processes and drifted apart silently for
  // exactly this reason, so the clamp itself is lifted out of main.js and run.
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const clampLine = mainSource
    .split('\n')
    .find(line => line.includes('Number.isFinite(pixels) && pixels > 0'));
  assert.ok(clampLine, 'the pixelSize clamp is still where this test expects it');

  const clamp = new Function('pixels', clampLine.trim());
  const { norm } = roundTripApi();

  for (const pixels of [1, 2, 21, 23, 24, 25, 39, 40, 41, 100, 599, 600, 601, 5000]) {
    const emitted = clamp(pixels);
    // 0 is main.js's "hidden" sentinel; both consumers skip it before storing.
    if (emitted === 0) continue;
    const kept = norm(widthBook([emitted])).projects[0].sheets[0].colWidths[0];
    assert.equal(kept, emitted,
      `a Google column of ${pixels}px becomes ${emitted}, which must survive storage unchanged`);
  }
});

// ── MB1188-016: structure moving under a local edit holds the tab ────────────
//
// Inserting a row in Google shifts everything below it. The merge is keyed by
// absolute "row,column", so an edit made here stays at its old coordinate,
// destroys whatever moved into that slot, and its own row comes back with the
// edit undone. Rows nobody edited self-correct — "Google changed, the app did
// not" takes Google's value, which after a shift IS the shifted content.
//
// The first fix recovered the mapping with an LCS diff and shifted the cells.
// A pentest killed it: deleting a column can make one row's new signature equal
// a DIFFERENT row's old signature, so every uniqueness guard passed and an edit
// was relocated onto the wrong row with no conflict raised. Uniqueness proves a
// line is unique on each side, never that a match is the same line.
//
// So this maps nothing. It detects that content moved while the app has unsent
// edits, and holds the tab. The tests below therefore assert refusals and
// non-refusals — there is no success case that changes data.

function structureHoldApi() {
  const context = vm.createContext({
    String, JSON, Object, Array, Number, Math, Boolean, Map, Set, RegExp, console,
  });
  vm.runInContext(`
    ${declaration('_ssCheckpointCell')}
    ${declaration('_ssCellSignature')}
    ${declaration('_ssSignatureIsBlank')}
    ${declaration('_ssContentRelocated')}
    ${declaration('_ssGoogleStructureHold')}
    globalThis.hold = a => _ssGoogleStructureHold(a);
  `, context);

  const cell = v => ({ v, bg: '', tc: '', b: false });
  // before/after are column-0 contents; edits are applied to the app copy.
  return function check({ before, after, edits = {}, cols = 1 }) {
    const checkpoint = {};
    const existing = {};
    before.forEach((v, r) => { if (v !== '') { checkpoint[`${r},0`] = v; existing[`${r},0`] = cell(v); } });
    for (const [r, v] of Object.entries(edits)) existing[`${r},0`] = cell(v);
    const incoming = new Map();
    after.forEach((v, r) => { if (v !== '') incoming.set(`${r},0`, cell(v)); });
    return context.hold({
      checkpoint, incoming, existing,
      rows: Math.max(before.length, after.length), cols,
    });
  };
}

test('MB1188-016: a row inserted in Google under a local edit holds the tab', () => {
  const check = structureHoldApi();
  const result = check({
    before: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    after: ['Mon', '', 'Tue', 'Wed', 'Thu', 'Fri'],
    edits: { 3: 'Thu — CANCELLED' },
  });
  assert.match(result.reason || '', /rows or columns moved in Google/);
});

test('MB1188-016: a row deleted in Google under a local edit holds the tab', () => {
  const check = structureHoldApi();
  const result = check({
    before: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    after: ['Mon', 'Wed', 'Thu', 'Fri', ''],
    edits: { 3: 'Thu — CANCELLED' },
  });
  assert.match(result.reason || '', /rows or columns moved in Google/);
});

test('MB1188-016: with no local edits a shift is NOT held — the merge handles it', () => {
  // The whole point of scoping this to dirty lines. Holding every Google insert
  // would stop an untouched mirror from ever syncing again.
  const check = structureHoldApi();
  assert.equal(check({
    before: ['Mon', 'Tue', 'Wed'],
    after: ['Mon', '', 'Tue', 'Wed'],
  }).refuse, undefined);
});

test('MB1188-016: an ordinary concurrent edit is NOT held', () => {
  // Google changed a row in place while the app edited a different row. Nothing
  // moved, so _ssMergeCellFromGoogle resolves it cell by cell as before. This is
  // the case that must never be refused — it is the common one.
  const check = structureHoldApi();
  assert.equal(check({
    before: ['Mon', 'Tue', 'Wed'],
    after: ['Mon', 'Tuesday', 'Wed'],
    edits: { 2: 'Wed — CANCELLED' },
  }).refuse, undefined);
});

test('MB1188-016: a column deleted in Google under a local edit holds the tab', () => {
  // The case that defeated the LCS design: deleting a column can make one row's
  // new signature equal a different row's old one, so a content-matching MAP
  // relocated an edit onto the wrong row silently. Detection needs no map — a
  // column delete moves a whole column's worth of cells by the same offset.
  const context = vm.createContext({
    String, JSON, Object, Array, Number, Math, Boolean, Map, Set, RegExp, console,
  });
  vm.runInContext(`
    ${declaration('_ssCheckpointCell')}
    ${declaration('_ssCellSignature')}
    ${declaration('_ssSignatureIsBlank')}
    ${declaration('_ssContentRelocated')}
    ${declaration('_ssGoogleStructureHold')}
    globalThis.hold = a => _ssGoogleStructureHold(a);
  `, context);
  const cell = v => ({ v, bg: '', tc: '', b: false });

  const checkpoint = {};
  const existing = {};
  const incoming = new Map();
  for (let r = 0; r < 5; r++) {
    checkpoint[`${r},0`] = `Time ${r}`;
    checkpoint[`${r},1`] = `Doomed ${r}`;
    checkpoint[`${r},2`] = `Room ${r}`;
    checkpoint[`${r},3`] = `Staff ${r}`;
    for (const [k, v] of Object.entries(checkpoint)) if (k.startsWith(`${r},`)) existing[k] = cell(v);
    // Google deleted column 1; everything to its right shifted one column left.
    incoming.set(`${r},0`, cell(`Time ${r}`));
    incoming.set(`${r},1`, cell(`Room ${r}`));
    incoming.set(`${r},2`, cell(`Staff ${r}`));
  }
  existing['2,2'] = cell('Room 2 — MOVED TO STUDIO B');   // an edit made here

  const result = context.hold({ checkpoint, incoming, existing, rows: 5, cols: 4 });

  assert.equal(result.refuse, true, 'held rather than realigned onto the wrong line');
});

test('MB1188-016: a shift too small to corroborate is NOT held — a known limit', () => {
  // Honest boundary. Holding needs either several cells agreeing on one offset
  // or a cell whose content is unique on both sides. A one-cell shift of a
  // REPEATED value satisfies neither, so it falls through to the ordinary cell
  // merge — which raises a conflict rather than silently overwriting.
  //
  // The alternative was holding on any repeated value appearing elsewhere, and
  // that held every ordinary edit on a real schedule tab. This is the trade.
  const context = vm.createContext({
    String, JSON, Object, Array, Number, Math, Boolean, Map, Set, RegExp, console,
  });
  vm.runInContext(`
    ${declaration('_ssCheckpointCell')}
    ${declaration('_ssCellSignature')}
    ${declaration('_ssSignatureIsBlank')}
    ${declaration('_ssContentRelocated')}
    ${declaration('_ssGoogleStructureHold')}
    globalThis.hold = a => _ssGoogleStructureHold(a);
  `, context);
  const cell = v => ({ v, bg: '', tc: '', b: false });

  const checkpoint = { '0,0': 'Dup', '1,0': 'Dup' };
  const existing = { '0,0': cell('Dup'), '1,0': cell('Dup EDITED') };
  const incoming = new Map([['1,0', cell('Dup')]]);

  assert.equal(context.hold({ checkpoint, incoming, existing, rows: 2, cols: 1 }).refuse, undefined);
});

test('MB1188-016: a blank line cannot be used as evidence of movement', () => {
  // Blank signatures match every other blank, which is how the old design
  // produced identity mappings and skipped its own guards. They are excluded
  // from movement detection entirely.
  const check = structureHoldApi();
  assert.equal(check({
    before: ['Mon', '', ''],
    after: ['Mon', '', ''],
    edits: { 1: 'Added here' },
  }).refuse, undefined, 'nothing actually moved, so nothing is held');
});

// ── MB1188-030: a held tab has to be able to clear ───────────────────────────
//
// Nothing is ever written back to Google — the OAuth scope is
// spreadsheets.readonly. So when the merge keeps this Mac's value, the
// checkpoint still records GOOGLE's, and those two never reconverge. Reading
// that difference as "an unsent edit" made every actively-used tab permanently
// dirty, so the first structural change in Google held it forever, with
// re-importing the only way out. Isaiah hit exactly this: a held Monday tab
// stopped syncing anything at all, including rows added in Google afterwards.
//
// `settled` records the divergences the last merge deliberately kept, so only
// genuinely new edits count as dirty.

function holdWithSettled() {
  const context = vm.createContext({
    String, JSON, Object, Array, Number, Math, Boolean, Map, Set, RegExp, console,
  });
  vm.runInContext(`
    ${declaration('_ssCheckpointCell')}
    ${declaration('_ssCellSignature')}
    ${declaration('_ssSignatureIsBlank')}
    ${declaration('_ssContentRelocated')}
    ${declaration('_ssGoogleStructureHold')}
    globalThis.hold = a => _ssGoogleStructureHold(a);
    globalThis.sig = c => _ssCellSignature(c);
  `, context);
  return context;
}

test('MB1188-030: a divergence the merge settled does not count as a new edit', () => {
  const context = holdWithSettled();
  const cell = v => ({ v, bg: '', tc: '', b: false });

  // Twelve rows mirrored from Google. One cell was resolved in this Mac's
  // favour at the last merge, so it differs from the checkpoint on purpose.
  const checkpoint = {};
  const existing = {};
  const incoming = new Map();
  for (let r = 0; r < 12; r++) {
    checkpoint[`${r},0`] = `Time ${r}`;
    checkpoint[`${r},1`] = `Student ${r}`;
    existing[`${r},0`] = cell(`Time ${r}`);
    existing[`${r},1`] = cell(`Student ${r}`);
    incoming.set(`${r + 2},0`, cell(`Time ${r}`));      // Google inserted 2 rows on top
    incoming.set(`${r + 2},1`, cell(`Student ${r}`));
  }
  existing['5,1'] = cell('Student 5 — CANCELLED');
  const settled = { '5,1': context.sig(cell('Student 5 — CANCELLED')) };

  // Without the record, this is the permanent-hold state Isaiah hit.
  assert.equal(context.hold({ checkpoint, incoming, existing, rows: 14, cols: 2 }).refuse, true,
    'a settled divergence used to read as an unsent edit forever');

  // With it, the tab syncs — there is nothing new at risk.
  assert.equal(context.hold({ checkpoint, incoming, existing, settled, rows: 14, cols: 2 }).refuse, undefined,
    'a divergence the merge already settled is not a reason to hold');
});

test('MB1188-030: a NEW edit on top of a settled cell still holds', () => {
  // The protection has to survive the fix: somebody editing that same cell
  // again, after the merge settled it, is exactly the case the hold exists for.
  const context = holdWithSettled();
  const cell = v => ({ v, bg: '', tc: '', b: false });

  const checkpoint = {};
  const existing = {};
  const incoming = new Map();
  for (let r = 0; r < 12; r++) {
    checkpoint[`${r},0`] = `Time ${r}`;
    checkpoint[`${r},1`] = `Student ${r}`;
    existing[`${r},0`] = cell(`Time ${r}`);
    existing[`${r},1`] = cell(`Student ${r}`);
    incoming.set(`${r + 2},0`, cell(`Time ${r}`));
    incoming.set(`${r + 2},1`, cell(`Student ${r}`));
  }
  const settled = { '5,1': context.sig(cell('Student 5 — CANCELLED')) };
  existing['5,1'] = cell('Student 5 — CANCELLED AGAIN, DIFFERENTLY');

  assert.equal(context.hold({ checkpoint, incoming, existing, settled, rows: 14, cols: 2 }).refuse, true,
    'the recorded signature no longer matches, so this is a fresh edit');
});

test('MB1188-030: the merge records what it settled, and the link carries it', () => {
  // Wiring — the behaviour above is only reachable if the pull actually writes
  // `settled` and the workbook validator lets it through.
  const pull = declaration('ssPullFromGoogle');
  assert.match(pull, /if \(settledSignature !== googleSignature\) settled\[key\] = settledSignature;/,
    'the merge records every divergence it deliberately kept');
  assert.match(pull, /\.\.\.\(Object\.keys\(settled\)\.length \? \{ settled \} : \{\}\)/,
    'and writes it beside the checkpoint it qualifies');
  assert.match(pull, /settled: tab\.settled/, 'and the hold is given it');

  const normalize = declaration('normalizeSpreadsheetWorkbook');
  assert.match(normalize, /'mergeSig', 'settled'/,
    'the tab allowlist admits it — otherwise the whole workbook is refused');
  assert.match(normalize, /MAX_SPREADSHEET_SETTLED_CELLS/, 'and it is bounded');
});

// ── MB1188-031: the sheet ceiling is a TOTAL, and the message has to say so ───
//
// Importing a 6-tab Google spreadsheet was refused with "spreadsheets exceeds
// the 25-sheet limit" while the workbook already held 21 sheets across five
// projects. The number is a total across every project, but the message reads
// as a complaint about the spreadsheet being imported — Isaiah replied, quite
// reasonably, that the project only has 6 sheets.
//
// Worse, nothing checked it up front. _ssCapacityRefusal measured cells,
// characters and bytes but not sheets, so the import built everything, tried to
// save, and was refused by the workbook validator instead — the exact
// half-built failure MB161-011 exists to prevent.

// Isaiah's actual workbook: 6 + 7 + 2 + 4 + 2 = 21 sheets across five projects.
const studioWorkbook = () => ({
  activeProject: 'p1',
  projects: [6, 7, 2, 4, 2].map((count, i) => ({
    id: `p${i + 1}`,
    name: `Project ${i + 1}`,
    sheets: Array.from({ length: count }, (_, n) => ({
      id: `p${i + 1}s${n}`, name: `S${n}`, rows: 5, cols: 5, colWidths: [], cells: {},
    })),
  })),
});

test('MB1188-031: the sheet total is counted across every project, not just the open one', () => {
  // Split storage measures cells per project; the sheet ceiling is not per
  // project, and counting it that way would never refuse anything.
  const { api } = capacityApi(studioWorkbook());
  assert.equal(api.capacity().sheets.used, 21);
  assert.equal(api.capacity().sheets.limit, 25);
});

test('MB1188-031: a 6-tab import over the total is refused UP FRONT, with the arithmetic', () => {
  const { api } = capacityApi(studioWorkbook());

  const refusal = api.refusal({ cells: 200, characters: 900, bytes: 4000, sheets: 6 });

  assert.ok(refusal, 'refused before anything is built or written');
  // The numbers Isaiah needed and did not get.
  assert.match(refusal, /27 sheets across all projects/);
  assert.match(refusal, /21 now/);
  assert.match(refusal, /plus 6/);
  assert.match(refusal, /limit of 25 in total/);
});

test('MB1188-031: an import that fits is not refused', () => {
  const { api } = capacityApi(studioWorkbook());
  assert.equal(api.refusal({ cells: 10, characters: 10, bytes: 10, sheets: 4 }), null);
});

test('MB1188-031: a workbook already over the ceiling can still be pruned', () => {
  // The no-exit trap the cells/characters/bytes checks already avoid: if being
  // over were enough to refuse, deleting a project would be refused too — and
  // deleting is the only way back under.
  const over = studioWorkbook();
  over.projects.push({
    id: 'p6', name: 'Overflow',
    sheets: Array.from({ length: 10 }, (_, n) => ({
      id: `p6s${n}`, name: `S${n}`, rows: 5, cols: 5, colWidths: [], cells: {},
    })),
  });
  const { api } = capacityApi(over);
  assert.equal(api.capacity().sheets.used, 31);
  assert.equal(api.refusal({ sheets: -10 }), null, 'removing sheets is never refused');
});

test('MB1188-031: the validator says the limit is a total', () => {
  assert.match(declaration('normalizeSpreadsheetWorkbook'),
    /more than \$\{MAX_SPREADSHEET_SHEETS\} sheets across all projects combined/,
    'anything that still reaches the validator gets an honest message');
});

test('MB1188-031: the sheet total and the project count are separate ceilings', () => {
  // They shared one constant, so raising the sheet total from 25 to 60 would
  // have silently allowed 60 projects — past the 25 the index normalizer still
  // enforces, which is a refusal on save rather than a refusal up front.
  const script = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(script, /const MAX_SPREADSHEET_SHEETS = 60;/, 'sheets, in total, across all projects');
  assert.match(script, /const MAX_SPREADSHEET_PROJECTS = 25;/, 'projects');
  assert.match(declaration('normalizeSpreadsheetWorkbook'),
    /source\.projects\.length > MAX_SPREADSHEET_PROJECTS/,
    'the project count is checked against the project limit, not the sheet one');
  assert.match(declaration('normalizeSpreadsheetIndex'),
    /live\.length > MAX_SPREADSHEET_PROJECTS/,
    'and the index agrees, so the two cannot disagree about what is savable');
});
