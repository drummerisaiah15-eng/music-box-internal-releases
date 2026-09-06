'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSource, normalizeConfig, fetchWindow, nextAttemptAt, duePlan,
  interpretOutput, extractJsonArray, recordAttempt, healthReport, renderCommand,
  fetchEnvironment, FetchError,
} = require('../src/fetch');

const NOW = '2026-09-06T14:00:00.000Z';

function source(over = {}) {
  return normalizeSource('gcal', {
    collection: 'calendar', mode: 'full', everyMinutes: 60,
    command: ['fetcher', '--from', '{{since}}', '--to', '{{until}}'],
    ...over,
  });
}

function stateAfter(entries) {
  return { sources: entries };
}

test('a fetcher needs a known collection and a runnable shape', () => {
  assert.throws(() => normalizeSource('x', { collection: 'invoices', command: ['a'] }), /needs a collection/);
  assert.throws(() => normalizeSource('x', { collection: 'calendar' }), /needs a command/);
  assert.throws(() => normalizeSource('x', { collection: 'calendar', command: 'a shell string' }), /array of arguments/);
  assert.throws(() => normalizeSource('x', { collection: 'calendar', command: [1, 2] }), /must all be strings/);
  assert.throws(() => normalizeSource('x', { collection: 'statements', kind: 'file-drop' }), /needs a directory/);
});

// A windowed fetch never returns the whole file, so it can never conclude a
// record was withdrawn. Combining the two would empty the year on run one.
test('statements can never be configured as a full sync', () => {
  assert.throws(
    () => normalizeSource('x', { collection: 'statements', mode: 'full', command: ['a'] }),
    /always incremental/,
  );
});

test('the first window falls back to the configured lookback', () => {
  const window = fetchWindow(source({ lookbackDays: 7 }), {}, NOW);
  assert.equal(window.since, '2026-08-30T14:00:00.000Z');
  assert.equal(window.firstRun, true);
});

test('later windows start just before the last success, to catch backdating', () => {
  const window = fetchWindow(source({ overlapMinutes: 120 }), stateAfter({ gcal: { lastSuccessAt: '2026-09-06T12:00:00Z' } }), NOW);
  assert.equal(window.since, '2026-09-06T10:00:00.000Z');
  assert.equal(window.firstRun, false);
});

test('a calendar window reaches forwards, everything else backwards', () => {
  assert.equal(fetchWindow(source({ horizonDays: 14 }), {}, NOW).until, '2026-09-20T14:00:00.000Z');
  const docs = normalizeSource('mail', { collection: 'documents', command: ['a'] });
  assert.equal(fetchWindow(docs, {}, NOW).until, NOW);
});

// The rule the whole module exists for.
test('a failure never advances the watermark', () => {
  const gcal = source();
  let state = recordAttempt({}, { source: gcal, at: '2026-09-06T12:00:00Z', ok: true, counts: { added: 3 } });
  const good = state.fetchers.gcal.lastSuccessAt;

  state = recordAttempt(state, { source: gcal, at: '2026-09-06T13:00:00Z', ok: false, reason: 'token expired' });
  state = recordAttempt(state, { source: gcal, at: NOW, ok: false, reason: 'token expired' });

  assert.equal(state.fetchers.gcal.lastSuccessAt, good);
  assert.equal(state.fetchers.gcal.consecutiveFailures, 2);
  assert.equal(state.fetchers.gcal.lastError, 'token expired');
});

test('after failures the window still reaches back to the last good fetch', () => {
  const gcal = source();
  let state = recordAttempt({}, { source: gcal, at: '2026-09-06T12:00:00Z', ok: true });
  state = recordAttempt(state, { source: gcal, at: '2026-09-06T13:00:00Z', ok: false, reason: 'x' });
  const window = fetchWindow(gcal, stateAfter(state.fetchers), '2026-09-06T18:00:00Z');
  assert.equal(window.since, '2026-09-06T10:00:00.000Z', 'nothing between 12:00 and now may be skipped');
});

test('a success clears the failure count', () => {
  const gcal = source();
  let state = recordAttempt({}, { source: gcal, at: '2026-09-06T12:00:00Z', ok: false, reason: 'x' });
  state = recordAttempt(state, { source: gcal, at: NOW, ok: true, counts: { added: 1 } });
  assert.equal(state.fetchers.gcal.consecutiveFailures, 0);
  assert.equal(state.fetchers.gcal.lastError, null);
});

test('failures back off exponentially and then cap', () => {
  const gcal = source({ everyMinutes: 30, maxBackoffMinutes: 120 });
  const at = (failures) => nextAttemptAt(gcal, stateAfter({
    gcal: { lastAttemptAt: '2026-09-06T12:00:00Z', consecutiveFailures: failures },
  }));
  assert.equal(at(0), '2026-09-06T12:30:00.000Z');
  assert.equal(at(1), '2026-09-06T13:00:00.000Z');
  assert.equal(at(2), '2026-09-06T14:00:00.000Z');
  assert.equal(at(9), '2026-09-06T14:00:00.000Z', 'capped, so a broken fetcher stops hammering');
});

test('a source that has never run is due immediately', () => {
  assert.equal(nextAttemptAt(source(), {}), null);
  assert.equal(duePlan([source()], {}, NOW).due.length, 1);
});

test('a source not yet due is skipped with the time it is next due', () => {
  const state = stateAfter({ gcal: { lastAttemptAt: '2026-09-06T13:30:00Z', consecutiveFailures: 0 } });
  const plan = duePlan([source()], state, NOW);
  assert.equal(plan.due.length, 0);
  assert.match(plan.skipped[0].reason, /not due until/);
});

test('--force overrides the schedule', () => {
  const state = stateAfter({ gcal: { lastAttemptAt: '2026-09-06T13:59:00Z' } });
  assert.equal(duePlan([source()], state, NOW, { force: true }).due.length, 1);
});

test('a disabled source is skipped and says so', () => {
  const plan = duePlan([source({ enabled: false })], {}, NOW);
  assert.equal(plan.due.length, 0);
  assert.match(plan.skipped[0].reason, /disabled/);
});

// A source the caller did not ask for was not skipped; it was never in scope,
// and reporting it pushes the line they wanted off the top.
test('selecting one source does not report the others as skipped', () => {
  const docs = normalizeSource('mail', { collection: 'documents', command: ['a'] });
  const plan = duePlan([source(), docs], {}, NOW, { only: 'mail' });
  assert.equal(plan.due.length, 1);
  assert.equal(plan.due[0].source.name, 'mail');
  assert.equal(plan.skipped.length, 0);
});

test('a collection name selects every source feeding it', () => {
  const a = normalizeSource('gmail', { collection: 'documents', command: ['a'] });
  const b = normalizeSource('drive', { collection: 'documents', command: ['b'] });
  assert.equal(duePlan([source(), a, b], {}, NOW, { only: 'documents' }).due.length, 2);
});

test('records are read off stdout', () => {
  const result = interpretOutput({ status: 0, stdout: '[{"sourceId":"a"}]', stderr: '' });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
});

// A quiet day is a success. Treating it as a failure would trigger backoff on
// exactly the sources that are working fine.
test('no output at all is an empty success, not a failure', () => {
  const result = interpretOutput({ status: 0, stdout: '   ', stderr: '' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.records, []);
});

test('a log line before the JSON does not fail the fetch', () => {
  const result = interpretOutput({ status: 0, stdout: 'Fetching...\n[{"sourceId":"a"}]\n', stderr: '' });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
});

test('a { records: [...] } envelope is accepted', () => {
  assert.equal(extractJsonArray('{"records":[{"sourceId":"a"}]}').records.length, 1);
});

test('a non-zero exit is a failure carrying the fetcher\'s own message', () => {
  const result = interpretOutput({ status: 3, stdout: '', stderr: 'token expired\n' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exited 3/);
  assert.match(result.reason, /token expired/);
});

test('a timeout says what to change', () => {
  const result = interpretOutput({ status: null, stdout: '', stderr: '', timedOut: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timeoutSeconds/);
});

test('output that is not JSON, or not a list, is refused with the shape wanted', () => {
  assert.match(interpretOutput({ status: 0, stdout: 'hello there' }).reason, /not JSON/);
  assert.match(interpretOutput({ status: 0, stdout: '{"a":1}' }).reason, /array of records/);
});

test('a missing executable is reported as such', () => {
  const result = interpretOutput({ status: null, error: 'spawn nope ENOENT' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not run the fetcher/);
});

test('the window reaches the fetcher as both arguments and environment', () => {
  const gcal = source();
  const window = fetchWindow(gcal, {}, NOW);
  assert.deepEqual(renderCommand(gcal, window), ['fetcher', '--from', window.since, '--to', window.until]);
  const env = fetchEnvironment(gcal, window);
  assert.equal(env.AI_EA_SINCE, window.since);
  assert.equal(env.AI_EA_COLLECTION, 'calendar');
});

test('placeholders are substituted everywhere they appear', () => {
  const gcal = source({ command: ['claude', '-p', 'events {{since}}..{{until}} for {{collection}}'] });
  const rendered = renderCommand(gcal, fetchWindow(gcal, {}, NOW));
  assert.match(rendered[2], /events 2026-08-30.*\.\.2026-09-20.* for calendar/);
});

test('health reports a source that has gone quiet', () => {
  const gcal = source({ everyMinutes: 60 });
  const state = { fetchers: { gcal: { lastSuccessAt: '2026-09-06T04:00:00Z', consecutiveFailures: 0 } } };
  const [row] = healthReport([gcal], state, NOW);
  assert.equal(row.stale, true);
  assert.match(row.note, /last success 10 hours ago/);
});

test('health does not cry stale inside the expected interval', () => {
  const state = { fetchers: { gcal: { lastSuccessAt: '2026-09-06T13:30:00Z' } } };
  assert.equal(healthReport([source({ everyMinutes: 60 })], state, NOW)[0].stale, false);
});

test('a source that has never succeeded is stale and says why', () => {
  const [row] = healthReport([source()], {}, NOW);
  assert.equal(row.stale, true);
  assert.match(row.note, /never fetched successfully/);
});

test('a disabled source is never reported stale', () => {
  assert.equal(healthReport([source({ enabled: false })], {}, NOW)[0].stale, false);
});

test('config parses a whole file of sources', () => {
  const sources = normalizeConfig({
    sources: {
      gcal: { collection: 'calendar', mode: 'full', command: ['a'] },
      drop: { collection: 'statements', kind: 'file-drop', directory: '/tmp/x', account: 'amex' },
    },
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[1].kind, 'file-drop');
  assert.equal(sources[1].archiveTo, 'imported');
  assert.throws(() => normalizeConfig({ sources: 'nope' }), FetchError);
});
