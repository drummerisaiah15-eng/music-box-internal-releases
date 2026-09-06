'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reduceEvents } = require('../src/ledger');
const { buildBrief, renderBrief, calendarProblems, normalizeEvent } = require('../src/brief');

const NOW = '2026-09-06T14:00:00Z';
const PROFILE = { principal: 'Dana Reyes' };

function created(id, overrides = {}, at = '2026-09-01T09:00:00Z') {
  return {
    type: 'created',
    at,
    commitment: { id, title: `Task ${id}`, lane: 'project', priority: 'high', source: 'email:test', ...overrides },
  };
}

function event(overrides = {}) {
  return { id: 'e1', title: 'Meeting', start: '2026-09-06T15:00:00Z', end: '2026-09-06T16:00:00Z', ...overrides };
}

test('overlapping meetings are reported as a conflict', () => {
  const problems = calendarProblems([
    normalizeEvent(event({ id: 'a' }), 0),
    normalizeEvent(event({ id: 'b', start: '2026-09-06T15:30:00Z', end: '2026-09-06T16:30:00Z' }), 1),
  ]);
  assert.equal(problems[0].kind, 'conflict');
  assert.match(problems[0].message, /overlap by 30 min/);
});

// A calendar with no double-bookings can still be about to fail.
test('too little time between meetings in different places is flagged as blocking', () => {
  const problems = calendarProblems([
    normalizeEvent(event({ id: 'a', location: 'Studio A' }), 0),
    normalizeEvent(event({ id: 'b', start: '2026-09-06T16:05:00Z', end: '2026-09-06T17:00:00Z', location: 'Downtown branch' }), 1),
  ]);
  assert.equal(problems[0].kind, 'travel-gap');
  assert.equal(problems[0].severity, 'blocking');
});

test('a tight gap in one place is advisory, not blocking', () => {
  const problems = calendarProblems([
    normalizeEvent(event({ id: 'a', location: 'Studio A' }), 0),
    normalizeEvent(event({ id: 'b', start: '2026-09-06T16:05:00Z', end: '2026-09-06T17:00:00Z', location: 'Studio A' }), 1),
  ]);
  assert.equal(problems[0].severity, 'advisory');
});

test('a comfortable gap raises nothing', () => {
  const problems = calendarProblems([
    normalizeEvent(event({ id: 'a' }), 0),
    normalizeEvent(event({ id: 'b', start: '2026-09-06T17:00:00Z', end: '2026-09-06T18:00:00Z' }), 1),
  ]);
  assert.equal(problems.length, 0);
});

test('problems are found regardless of the order events arrive in', () => {
  const late = normalizeEvent(event({ id: 'b', start: '2026-09-06T15:30:00Z', end: '2026-09-06T16:30:00Z' }), 1);
  const early = normalizeEvent(event({ id: 'a' }), 0);
  assert.equal(calendarProblems([late, early]).length, 1);
});

test('an event ending before it starts is refused', () => {
  assert.throws(() => normalizeEvent({ start: '2026-09-06T16:00:00Z', end: '2026-09-06T15:00:00Z' }, 0), /ends before it starts/);
});

test('only today lands in today\'s brief', () => {
  const brief = buildBrief({
    now: NOW,
    profile: PROFILE,
    commitments: reduceEvents([]),
    calendar: [event({ id: 'today' }), event({ id: 'tomorrow', start: '2026-09-07T15:00:00Z', end: '2026-09-07T16:00:00Z' })],
  });
  assert.equal(brief.calendar.count, 1);
  assert.equal(brief.calendar.events[0].id, 'today');
});

// Regression: one commitment surfacing under decisions, due-today and chasing
// turned one problem into three and trained the reader to skim.
test('a commitment appears exactly once across the brief', () => {
  const state = reduceEvents([
    created('stalled', { status: 'waiting', waitingOn: 'Marcus' }),
    { type: 'nudged', at: '2026-09-02T09:00:00Z', commitmentId: 'stalled' },
    { type: 'nudged', at: '2026-09-04T09:00:00Z', commitmentId: 'stalled' },
  ]);
  const brief = buildBrief({ now: NOW, profile: PROFILE, commitments: state });

  const appearances = [
    ...brief.decisions.map(d => d.id),
    ...brief.overdue.map(r => r.id),
    ...brief.dueToday.map(r => r.id),
    ...brief.chasing.map(r => r.id),
    ...brief.onDeck.map(r => r.id),
  ].filter(id => id === 'stalled');
  assert.equal(appearances.length, 1);
  assert.equal(brief.decisions[0].id, 'stalled');
});

test('a stalled item asks a real question rather than restating the status', () => {
  const state = reduceEvents([
    created('c1', { title: 'Studio B insurance certificate', status: 'waiting', waitingOn: 'Marcus at Halvorsen' }),
    { type: 'nudged', at: '2026-09-02T09:00:00Z', commitmentId: 'c1' },
    { type: 'nudged', at: '2026-09-04T09:00:00Z', commitmentId: 'c1' },
  ]);
  const brief = buildBrief({ now: NOW, profile: PROFILE, commitments: state });
  assert.match(brief.decisions[0].ask, /\?$/);
  assert.match(brief.decisions[0].ask, /Marcus at Halvorsen/);
});

test('explicit approvals lead the brief and keep their recommendation', () => {
  const brief = buildBrief({
    now: NOW,
    profile: PROFILE,
    commitments: reduceEvents([]),
    pendingApprovals: [{ id: 'a1', ask: 'Approve $3,400 console purchase?', reason: 'Above your $250 limit', recommendation: 'Approve — quoted 18% under the next bid.' }],
  });
  assert.equal(brief.decisions[0].kind, 'approval');
  assert.match(renderBrief(brief), /My recommendation: Approve/);
});

test('with nothing pending the brief says so instead of going quiet', () => {
  const rendered = renderBrief(buildBrief({ now: NOW, profile: PROFILE, commitments: reduceEvents([]) }));
  assert.match(rendered, /Needs a decision from you/);
  assert.match(rendered, /Nothing\./);
});

test('closed work is always reported, because invisible work looks expensive', () => {
  const state = reduceEvents([
    created('c1'),
    { type: 'completed', at: '2026-09-06T11:00:00Z', commitmentId: 'c1', reason: 'Booked and filed' },
  ]);
  const brief = buildBrief({ now: NOW, profile: PROFILE, commitments: state });
  assert.equal(brief.closedToday.length, 1);
  assert.match(renderBrief(brief), /Closed since yesterday/);
});

test('work closed on an earlier day is not re-reported', () => {
  const state = reduceEvents([
    created('c1'),
    { type: 'completed', at: '2026-09-05T11:00:00Z', commitmentId: 'c1', reason: 'done' },
  ]);
  assert.equal(buildBrief({ now: NOW, profile: PROFILE, commitments: state }).closedToday.length, 0);
});

test('a dropped item is reported with its reason, not silently omitted', () => {
  const state = reduceEvents([
    created('c1'),
    { type: 'dropped', at: '2026-09-06T11:00:00Z', commitmentId: 'c1', reason: 'Vendor withdrew' },
  ]);
  assert.match(renderBrief(buildBrief({ now: NOW, profile: PROFILE, commitments: state })), /dropped: Vendor withdrew/);
});

test('the money line agrees with itself grammatically', () => {
  const one = renderBrief(buildBrief({
    now: NOW, profile: PROFILE, commitments: reduceEvents([]),
    financeSnapshot: { unreceiptedCents: 61240, unreceiptedCount: 1, readiness: 63 },
  }));
  assert.match(one, /1 charge totalling \$612\.40 has no receipt behind it\./);

  const many = renderBrief(buildBrief({
    now: NOW, profile: PROFILE, commitments: reduceEvents([]),
    financeSnapshot: { unreceiptedCents: 120000, unreceiptedCount: 3, readiness: 40 },
  }));
  assert.match(many, /3 charges totalling \$1,200\.00 have no receipt behind them\./);
});

// A five-minute walk between venues is not a double-booking, and calling it one
// costs the assistant credibility on every later warning.
test('a travel gap is not labelled as a double-booking', () => {
  const brief = buildBrief({
    now: NOW,
    profile: PROFILE,
    commitments: reduceEvents([]),
    calendar: [
      event({ id: 'a', location: 'Studio A' }),
      event({ id: 'b', start: '2026-09-06T16:05:00Z', end: '2026-09-06T17:00:00Z', location: 'Downtown branch' }),
    ],
  });
  const rendered = renderBrief(brief);
  assert.match(rendered, /Not enough travel time/);
  assert.doesNotMatch(rendered, /Double-booked/);
});

test('headline counts match what the brief actually shows', () => {
  const state = reduceEvents([
    created('overdue', { dueAt: '2026-09-04T17:00:00Z' }),
    created('closed'),
    { type: 'completed', at: '2026-09-06T11:00:00Z', commitmentId: 'closed', reason: 'done' },
  ]);
  const brief = buildBrief({ now: NOW, profile: PROFILE, commitments: state });
  assert.equal(brief.counts.overdue, brief.overdue.length);
  assert.equal(brief.counts.closedToday, brief.closedToday.length);
  assert.match(renderBrief(brief), /0 need you · 1 overdue/);
});

// Every headline number must be the length of the list printed beneath it; an
// item promoted into "needs a decision" must leave the counts it came from.
test('headline counts never disagree with the sections they summarise', () => {
  const state = reduceEvents([
    created('stalled', { status: 'waiting', waitingOn: 'Marcus' }),
    { type: 'nudged', at: '2026-09-02T09:00:00Z', commitmentId: 'stalled' },
    { type: 'nudged', at: '2026-09-04T09:00:00Z', commitmentId: 'stalled' },
    created('late', { dueAt: '2026-09-04T17:00:00Z' }),
  ]);
  const brief = buildBrief({ now: NOW, profile: PROFILE, commitments: state });
  assert.equal(brief.counts.decisions, brief.decisions.length);
  assert.equal(brief.counts.overdue, brief.overdue.length);
  assert.equal(brief.counts.dueToday, brief.dueToday.length);
  assert.equal(brief.counts.chasing, brief.chasing.length);
  assert.equal(brief.counts.chasing, 0, 'an escalated item is no longer merely being chased');
  assert.match(renderBrief(brief), /1 needs you · 1 overdue · 0 due today · 0 being chased/);
});

test('the rendered brief is plain Markdown with no stray blank runs', () => {
  const state = reduceEvents([created('c1', { dueAt: '2026-09-04T17:00:00Z' })]);
  const rendered = renderBrief(buildBrief({ now: NOW, profile: PROFILE, commitments: state }));
  assert.doesNotMatch(rendered, /\n{3,}/);
  assert.match(rendered, /^# Daily brief — 2026-09-06/);
  assert.ok(rendered.endsWith('\n'));
});

test("the agenda lists what the day contains, in the principal's timezone", () => {
  const brief = buildBrief({
    now: NOW,
    profile: { principal: 'Dana Reyes', timezone: 'America/New_York' },
    commitments: reduceEvents([]),
    calendar: [event({ title: 'Vendor sync', location: 'Studio A' })],
  });
  const rendered = renderBrief(brief);
  // 15:00Z is 11:00 in New York; showing the principal 15:00 would be useless.
  assert.match(rendered, /11:00–12:00 Vendor sync — Studio A/);
  assert.match(rendered, /New York\./);
});

test('an unknown timezone degrades to UTC rather than failing the brief', () => {
  const brief = buildBrief({
    now: NOW,
    profile: { principal: 'Dana Reyes', timezone: 'Mars/Olympus' },
    commitments: reduceEvents([]),
    calendar: [event({ title: 'Vendor sync' })],
  });
  assert.match(renderBrief(brief), /15:00–16:00 Vendor sync/);
});

test('an empty day still produces a usable brief', () => {
  const rendered = renderBrief(buildBrief({ now: NOW, profile: PROFILE, commitments: reduceEvents([]) }));
  assert.match(rendered, /No meetings scheduled/);
  assert.match(rendered, /Nothing closed out today/);
});
