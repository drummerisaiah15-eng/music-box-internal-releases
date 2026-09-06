'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run, UsageError } = require('../src/cli');

const NOW = '2026-09-06T14:00:00Z';

function workspace(profileOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-ea-'));
  run(['init', '--workspace', dir, '--client', 'acme']);
  const file = path.join(dir, 'client.json');
  const profile = {
    ...JSON.parse(fs.readFileSync(file, 'utf8')),
    principal: 'Dana Reyes',
    spendApprovalCents: 25000,
    autoSendDomains: ['musicbox.com'],
    connectedSystems: ['gmail'],
    ...profileOverrides,
  };
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  return dir;
}

function write(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
}

test('init scaffolds a workspace and refuses to clobber it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-ea-'));
  run(['init', '--workspace', dir]);
  for (const file of ['client.json', 'documents.json', 'statements.json', 'ledger.jsonl']) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} was not created`);
  }
  assert.throws(() => run(['init', '--workspace', dir]), /--force/);
  assert.doesNotThrow(() => run(['init', '--workspace', dir, '--force']));
});

test('the scaffolded profile is deliberately not operational', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-ea-'));
  run(['init', '--workspace', dir]);
  const result = run(['readiness', '--workspace', dir, '--format', 'json']);
  assert.equal(result.data.operational, false, 'a template must never look configured');
});

test('a commitment logged through the CLI reaches the queue', () => {
  const dir = workspace();
  run(['add', '--workspace', dir, '--at', '2026-09-01T09:00:00Z', '--json',
    JSON.stringify({ id: 'c1', title: 'Send W-9', lane: 'finance', priority: 'high', source: 'email:882', dueAt: '2026-09-04T17:00:00Z' })]);
  const result = run(['queue', '--workspace', dir, '--now', NOW, '--format', 'json']);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].state, 'overdue');
});

test('the ledger is append-only on disk', () => {
  const dir = workspace();
  for (const id of ['c1', 'c2']) {
    run(['add', '--workspace', dir, '--at', '2026-09-01T09:00:00Z', '--json',
      JSON.stringify({ id, title: id, lane: 'project', source: 's' })]);
  }
  const lines = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).commitment.id, 'c1');
});

test('an invalid commitment is rejected before it reaches the log', () => {
  const dir = workspace();
  assert.throws(() => run(['add', '--workspace', dir, '--json', JSON.stringify({ id: 'bad', title: 'x', lane: 'nope', source: 's' })]));
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim(), '', 'the log must not carry a bad row');
});

test('events replay into the same state the engine would compute', () => {
  const dir = workspace();
  run(['add', '--workspace', dir, '--at', '2026-09-01T09:00:00Z', '--json',
    JSON.stringify({ id: 'c1', title: 'Insurance cert', lane: 'project', priority: 'high', source: 'call', status: 'waiting', waitingOn: 'Marcus' })]);
  run(['event', '--workspace', dir, '--at', '2026-09-02T09:00:00Z', '--json', JSON.stringify({ type: 'nudged', commitmentId: 'c1' })]);
  run(['event', '--workspace', dir, '--at', '2026-09-04T09:00:00Z', '--json', JSON.stringify({ type: 'nudged', commitmentId: 'c1' })]);
  const plan = run(['followups', '--workspace', dir, '--now', NOW, '--format', 'json']).data;
  assert.equal(plan[0].action, 'escalate');
  assert.equal(plan[0].attempt, 3);
});

test('a corrupt ledger line is reported with its line number', () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '{"type":"created"}\nnot json\n');
  assert.throws(() => run(['queue', '--workspace', dir, '--now', NOW]), /line 2/);
});

test('the brief renders from workspace files alone', () => {
  const dir = workspace();
  run(['add', '--workspace', dir, '--at', '2026-09-01T09:00:00Z', '--json',
    JSON.stringify({ id: 'c1', title: 'Send W-9', lane: 'finance', priority: 'high', source: 'email:882', dueAt: '2026-09-04T17:00:00Z' })]);
  write(dir, 'calendar.json', [{ id: 'e1', title: 'Vendor sync', start: '2026-09-06T15:00:00Z', end: '2026-09-06T16:00:00Z' }]);
  const text = run(['brief', '--workspace', dir, '--now', NOW]).text;
  assert.match(text, /# Daily brief — 2026-09-06/);
  assert.match(text, /Send W-9/);
  assert.match(text, /Vendor sync/);
});

test('the brief is byte-identical across runs when now is frozen', () => {
  const dir = workspace();
  run(['add', '--workspace', dir, '--at', '2026-09-01T09:00:00Z', '--json',
    JSON.stringify({ id: 'c1', title: 'x', lane: 'finance', priority: 'high', source: 's', dueAt: '2026-09-04T17:00:00Z' })]);
  assert.equal(run(['brief', '--workspace', dir, '--now', NOW]).text, run(['brief', '--workspace', dir, '--now', NOW]).text);
});

test('the brief folds in the finance position without being asked', () => {
  const dir = workspace();
  write(dir, 'documents.json', [{ id: 'd1', date: '2026-03-14', entity: 'MBX', docType: 'RECEIPT', counterparty: 'Sweetwater', amountCents: 128499, category: 'equipment', extension: 'pdf' }]);
  write(dir, 'statements.json', [
    { id: 'l1', date: '2026-03-16', description: 'SQ *SWEETWATER', amount: '-1284.99' },
    { id: 'l2', date: '2026-03-09', description: 'DELTA AIR', amount: '-612.40' },
  ]);
  assert.match(run(['brief', '--workspace', dir, '--now', NOW]).text, /\$612\.40/);
});

test('authority decisions are reachable from the command line', () => {
  const dir = workspace();
  assert.match(run(['authority', '--workspace', dir, '--json', JSON.stringify({ type: 'spend', amountCents: 99900 })]).text, /^DRAFT-FOR-APPROVAL/);
  assert.match(run(['authority', '--workspace', dir, '--json', JSON.stringify({ type: 'sign' })]).text, /^REFUSE/);
});

test('filing produces a path that audits clean', () => {
  const dir = workspace();
  const record = { date: '2026-03-14', entity: 'MBX', docType: 'RECEIPT', counterparty: 'Sweetwater Sound', amountCents: '$1,284.99', extension: 'pdf' };
  const filed = run(['file', '--workspace', dir, '--json', JSON.stringify(record)]).text.trim();
  const findings = run(['audit-files', '--workspace', dir, '--json', JSON.stringify([filed]), '--format', 'json']).data;
  assert.equal(findings[0].ok, true);
});

test('reconcile reports the unreceipted exposure in dollars', () => {
  const dir = workspace();
  write(dir, 'documents.json', [{ id: 'd1', date: '2026-03-14', entity: 'MBX', docType: 'RECEIPT', counterparty: 'Sweetwater', amountCents: 128499, category: 'equipment', extension: 'pdf' }]);
  write(dir, 'statements.json', [
    { id: 'l1', date: '2026-03-16', description: 'SQ *SWEETWATER', amount: '-1284.99' },
    { id: 'l2', date: '2026-03-09', description: 'DELTA AIR', amount: '-612.40' },
  ]);
  const text = run(['reconcile', '--workspace', dir]).text;
  assert.match(text, /Matched 1\/2 lines/);
  assert.match(text, /Unreceipted exposure: \$612\.40/);
});

test('the CPA packet refuses to declare itself ready with questions open', () => {
  const dir = workspace();
  write(dir, 'documents.json', [{ id: 'd1', date: '2026-03-14', entity: 'MBX', docType: 'RECEIPT', counterparty: 'Sweetwater', amountCents: 128499, category: 'equipment', extension: 'pdf' }]);
  write(dir, 'statements.json', [
    { id: 'l1', date: '2026-03-16', description: 'SQ *SWEETWATER', amount: '-1284.99' },
    { id: 'l2', date: '2026-03-09', description: 'DELTA AIR', amount: '-612.40' },
  ]);
  const text = run(['cpa-packet', '--workspace', dir, '--year', '2026', '--entity', 'MBX']).text;
  assert.match(text, /not tax determinations/);
  assert.match(text, /Status: not ready to send/);
});

test('claim verification is reachable and labels its confidence', () => {
  const dir = workspace();
  const text = run(['verify', '--workspace', dir, '--now', '2026-09-06T00:00:00Z', '--json',
    JSON.stringify({ claim: 'Vendor A is SOC 2 certified', sources: [{ kind: 'vendor', publisher: 'Vendor A site', retrievedOn: '2026-09-01' }] })]).text;
  assert.match(text, /^\[UNVERIFIED\]/);
  assert.match(text, /To settle:/);
});

test('decide emits a ranking and a recommendation', () => {
  const dir = workspace();
  const text = run(['decide', '--workspace', dir, '--json', JSON.stringify({
    question: 'Which payroll provider?',
    criteria: [{ id: 'cost', label: 'Cost', weight: 3, lowerIsBetter: true }, { id: 'support', label: 'Support', weight: 4 }],
    options: [{ id: 'A', scores: { cost: 2, support: 9 } }, { id: 'B', scores: { cost: 8, support: 3 } }],
  })]).text;
  assert.match(text, /Recommendation:/);
  assert.match(text, /Confidence: high/);
});

test('--format json returns structured data for every reporting command', () => {
  const dir = workspace();
  run(['add', '--workspace', dir, '--at', '2026-09-01T09:00:00Z', '--json',
    JSON.stringify({ id: 'c1', title: 'x', lane: 'finance', priority: 'high', source: 's' })]);
  for (const command of ['queue', 'followups', 'brief', 'readiness']) {
    const result = run([command, '--workspace', dir, '--now', NOW, '--format', 'json']);
    assert.doesNotThrow(() => JSON.parse(result.text), `${command} did not emit valid JSON`);
  }
});

test('payloads can arrive by file, flag or stdin', () => {
  const dir = workspace();
  const action = { type: 'spend', amountCents: 100 };
  const file = path.join(dir, 'action.json');
  fs.writeFileSync(file, JSON.stringify(action));
  const viaFile = run(['authority', '--workspace', dir, '--input', file]).text;
  const viaFlag = run(['authority', '--workspace', dir, '--json', JSON.stringify(action)]).text;
  const viaStdin = run(['authority', '--workspace', dir], { stdin: JSON.stringify(action) }).text;
  assert.equal(viaFile, viaFlag);
  assert.equal(viaFlag, viaStdin);
});

test('a command needing input says so rather than guessing', () => {
  const dir = workspace();
  assert.throws(() => run(['authority', '--workspace', dir]), UsageError);
});

test('malformed JSON is reported as such', () => {
  const dir = workspace();
  assert.throws(() => run(['authority', '--workspace', dir, '--json', '{oops']), /not valid JSON/);
});

test('an unknown command points at the help rather than failing obscurely', () => {
  assert.throws(() => run(['teleport']), /unknown command "teleport"/);
});

test('help lists every command the skills rely on', () => {
  const help = run([]).text;
  for (const command of ['init', 'readiness', 'add', 'event', 'queue', 'followups', 'brief',
    'authority', 'verify', 'decide', 'file', 'audit-files', 'reconcile', 'cpa-packet']) {
    assert.match(help, new RegExp(`\\b${command}\\b`), `${command} is missing from help`);
  }
});

test('a missing client profile is a clear error, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-ea-'));
  assert.throws(() => run(['readiness', '--workspace', dir]), /missing required file/);
});
