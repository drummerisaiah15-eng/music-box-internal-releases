'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCommitment, reduceEvents, assess, triageQueue, followUpPlan, LedgerError,
} = require('../src/ledger');

const NOW = '2026-09-06T14:00:00Z';

function created(id, overrides = {}, at = '2026-09-01T09:00:00Z') {
  return {
    type: 'created',
    at,
    commitment: {
      id,
      title: `Commitment ${id}`,
      lane: 'project',
      priority: 'high',
      source: 'email:test',
      ...overrides,
    },
  };
}

test('a commitment must declare where it came from', () => {
  assert.throws(
    () => normalizeCommitment({ id: 'a', title: 'x', lane: 'project' }),
    LedgerError,
    'provenance is what makes the ledger auditable, so it cannot be optional',
  );
});

test('a waiting commitment must name the person being waited on', () => {
  assert.throws(
    () => normalizeCommitment({ id: 'a', title: 'x', lane: 'project', source: 's', status: 'waiting' }),
    /must name who it is waiting on/,
  );
});

test('rejects a due date that precedes creation', () => {
  assert.throws(
    () => normalizeCommitment({
      id: 'a', title: 'x', lane: 'project', source: 's',
      createdAt: '2026-09-05T00:00:00Z', dueAt: '2026-09-01T00:00:00Z',
    }),
    /must not precede createdAt/,
  );
});

test('unknown lanes are refused rather than coerced', () => {
  assert.throws(() => normalizeCommitment({ id: 'a', title: 'x', lane: 'misc', source: 's' }), /lane must be one of/);
});

test('the log folds into current state', () => {
  const state = reduceEvents([
    created('c1'),
    { type: 'updated', at: '2026-09-02T09:00:00Z', commitmentId: 'c1', patch: { priority: 'critical' } },
    { type: 'nudged', at: '2026-09-03T09:00:00Z', commitmentId: 'c1' },
    { type: 'nudged', at: '2026-09-04T09:00:00Z', commitmentId: 'c1' },
  ]);
  const c1 = state.get('c1');
  assert.equal(c1.priority, 'critical');
  assert.equal(c1.nudgeCount, 2);
  // Timestamps are canonicalised to full ISO on the way in, so equal instants
  // written in different notations compare equal downstream.
  assert.equal(c1.lastNudgedAt, '2026-09-04T09:00:00.000Z');
});

test('provenance fields cannot be rewritten after creation', () => {
  assert.throws(
    () => reduceEvents([
      created('c1'),
      { type: 'updated', at: NOW, commitmentId: 'c1', patch: { source: 'somewhere else' } },
    ]),
    /source cannot be changed after creation/,
  );
});

test('a closed commitment is immutable', () => {
  assert.throws(
    () => reduceEvents([
      created('c1'),
      { type: 'completed', at: '2026-09-02T09:00:00Z', commitmentId: 'c1' },
      { type: 'updated', at: NOW, commitmentId: 'c1', patch: { title: 'reopened' } },
    ]),
    /already closed/,
  );
});

test('dropping something requires saying why', () => {
  assert.throws(
    () => reduceEvents([created('c1'), { type: 'dropped', at: NOW, commitmentId: 'c1' }]),
    /requires a reason/,
    'a drop with no reason is indistinguishable from forgetting',
  );
});

test('events cannot reference a commitment that was never created', () => {
  assert.throws(() => reduceEvents([{ type: 'nudged', at: NOW, commitmentId: 'ghost' }]), /unknown commitment/);
});

test('duplicate ids are refused', () => {
  assert.throws(() => reduceEvents([created('c1'), created('c1')]), /duplicate commitment id/);
});

test('overdue work reports how late it is', () => {
  const state = reduceEvents([created('c1', { dueAt: '2026-09-04T17:00:00Z' })]);
  const verdict = assess(state.get('c1'), NOW);
  assert.equal(verdict.state, 'overdue');
  assert.match(verdict.reason, /Overdue by 45 hours/);
});

test('an unanswered request is flagged even when its deadline is far off', () => {
  const state = reduceEvents([created('c1', { dueAt: '2026-12-01T17:00:00Z' })]);
  assert.equal(assess(state.get('c1'), NOW).state, 'unacknowledged');
});

test('acknowledging silences the acknowledgement clock', () => {
  const state = reduceEvents([
    created('c1', { dueAt: '2026-12-01T17:00:00Z' }),
    { type: 'acknowledged', at: '2026-09-01T10:00:00Z', commitmentId: 'c1' },
  ]);
  assert.equal(assess(state.get('c1'), NOW).state, 'on-track');
});

// Regression: a `waiting` row is one WE are chasing, so reporting "no reply
// sent" about it contradicts the chase count printed beside it.
test('a waiting commitment is never reported as unacknowledged', () => {
  const state = reduceEvents([created('c1', { status: 'waiting', waitingOn: 'Marcus' })]);
  const verdict = assess(state.get('c1'), NOW);
  assert.notEqual(verdict.state, 'unacknowledged');
  assert.match(verdict.reason, /Marcus/);
});

test('chasing is due once the nudge interval has elapsed', () => {
  const state = reduceEvents([
    created('c1', { status: 'waiting', waitingOn: 'Marcus' }, '2026-09-04T09:00:00Z'),
    { type: 'nudged', at: '2026-09-05T09:00:00Z', commitmentId: 'c1' },
  ]);
  const verdict = assess(state.get('c1'), NOW);
  assert.equal(verdict.state, 'chase-due');
  assert.equal(verdict.needsNudge, true);
});

test('chasing escalates once it has demonstrably stopped working', () => {
  const state = reduceEvents([
    created('c1', { status: 'waiting', waitingOn: 'Marcus' }),
    { type: 'nudged', at: '2026-09-02T09:00:00Z', commitmentId: 'c1' },
    { type: 'nudged', at: '2026-09-04T09:00:00Z', commitmentId: 'c1' },
  ]);
  const verdict = assess(state.get('c1'), NOW);
  assert.equal(verdict.needsEscalation, true);
  assert.equal(verdict.state, 'stalled');
});

test('we do not chase ourselves', () => {
  const state = reduceEvents([created('c1', { status: 'open' })]);
  assert.equal(assess(state.get('c1'), NOW).needsNudge, false);
});

test('escalating once stops it being re-escalated', () => {
  const state = reduceEvents([
    created('c1', { status: 'waiting', waitingOn: 'Marcus' }),
    { type: 'nudged', at: '2026-09-02T09:00:00Z', commitmentId: 'c1' },
    { type: 'nudged', at: '2026-09-04T09:00:00Z', commitmentId: 'c1' },
    { type: 'escalated', at: '2026-09-05T09:00:00Z', commitmentId: 'c1' },
  ]);
  assert.equal(assess(state.get('c1'), NOW).needsEscalation, false);
});

test('closed work leaves the queue', () => {
  const state = reduceEvents([
    created('c1', { dueAt: '2026-09-04T17:00:00Z' }),
    { type: 'completed', at: '2026-09-03T09:00:00Z', commitmentId: 'c1', reason: 'done' },
  ]);
  assert.equal(triageQueue(state, NOW).length, 0);
});

test('the queue is ordered worst-first and is stable across runs', () => {
  const state = reduceEvents([
    created('overdue-critical', { priority: 'critical', dueAt: '2026-09-02T09:00:00Z' }),
    created('ontrack', { priority: 'low', dueAt: '2026-12-01T09:00:00Z', acknowledgedAt: '2026-09-01T09:30:00Z' }),
    created('overdue-low', { priority: 'low', dueAt: '2026-09-05T09:00:00Z' }),
  ]);
  const first = triageQueue(state, NOW).map(row => row.commitment.id);
  const second = triageQueue(state, NOW).map(row => row.commitment.id);
  assert.deepEqual(first, second, 'a brief that reshuffles between runs cannot be trusted');
  assert.equal(first[0], 'overdue-critical');
  assert.equal(first.at(-1), 'ontrack');
});

test('lateness accumulates but cannot bury everything current', () => {
  const state = reduceEvents([
    created('ancient', { priority: 'low', dueAt: '2026-09-01T09:01:00Z' }, '2026-09-01T09:00:00Z'),
    created('today-critical', { priority: 'critical', dueAt: '2026-09-06T13:00:00Z' }, '2026-09-06T09:00:00Z'),
  ]);
  assert.equal(triageQueue(state, NOW)[0].commitment.id, 'today-critical');
});

test('the follow-up plan names the person and the attempt number', () => {
  const state = reduceEvents([
    created('c1', { status: 'waiting', waitingOn: 'Marcus at Halvorsen' }),
    { type: 'nudged', at: '2026-09-02T09:00:00Z', commitmentId: 'c1' },
  ]);
  const [plan] = followUpPlan(state, NOW);
  assert.equal(plan.waitingOn, 'Marcus at Halvorsen');
  assert.equal(plan.attempt, 2);
  assert.ok(['nudge', 'escalate'].includes(plan.action));
});

test('every live verdict carries an explanation fit to show the principal', () => {
  const state = reduceEvents([
    created('c1', { dueAt: '2026-09-04T17:00:00Z' }),
    created('c2', { status: 'waiting', waitingOn: 'Marcus' }),
    created('c3', { dueAt: '2026-12-01T09:00:00Z', acknowledgedAt: '2026-09-01T09:10:00Z' }),
  ]);
  for (const row of triageQueue(state, NOW)) {
    assert.ok(row.reason.length > 10, `${row.commitment.id} has no usable reason`);
    assert.match(row.reason, /[.!]$/, `${row.commitment.id} reason is not a sentence`);
  }
});

test('custom SLAs override the defaults', () => {
  const state = reduceEvents([created('c1', { priority: 'normal' }, '2026-09-06T12:00:00Z')]);
  const strict = assess(state.get('c1'), NOW, { slaOverrides: { normal: { acknowledgeHours: 1 } } });
  assert.equal(strict.state, 'unacknowledged');
  assert.equal(assess(state.get('c1'), NOW).state, 'on-track');
});
